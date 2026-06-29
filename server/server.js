// ============================================================
// OFW-NET SERVER v2.2 - RENDER OPTIMIZED
// ============================================================

const WebSocket = require('ws');
const dotenv = require('dotenv');
const path = require('path');
const fs = require('fs');
const http = require('http');

// Load environment variables
dotenv.config();

// Import database module
const db = require('./database');

// Configuration
const PORT = process.env.PORT || 3000;
const STAFF_PASSWORD = process.env.STAFF_PASSWORD || 'change_this_password';
const MONITOR_PASSWORD = process.env.MONITOR_PASSWORD || 'change_this_password';

// Create HTTP server (required for Render)
const server = http.createServer((req, res) => {
    // Health check endpoint for Render
    if (req.url === '/health') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ 
            status: 'ok', 
            pcs: Object.keys(pcs).length,
            staff: staff.length,
            monitors: monitors.length
        }));
        return;
    }
    
    // Simple status page
    if (req.url === '/') {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(`
            <!DOCTYPE html>
            <html>
            <head><title>OFW-NET Server</title></head>
            <body style="background:#0a1628;color:#5ba3d9;font-family:sans-serif;text-align:center;padding:50px;">
                <h1>🚀 OFW-NET Server Running</h1>
                <p>Status: Online</p>
                <p>PCs: ${Object.keys(pcs).length}</p>
                <p>Staff: ${staff.length}</p>
                <p>Monitors: ${monitors.length}</p>
                <p style="color:#5a7a9a;font-size:12px;margin-top:30px;">WebSocket endpoint: wss://${req.headers.host}</p>
            </body>
            </html>
        `);
        return;
    }
    
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not Found');
});

// Create WebSocket server attached to HTTP server
const wss = new WebSocket.Server({ 
    server,
    path: '/',  // Explicit path for Render
    clientTracking: true,
    perMessageDeflate: true
});

// Store active connections
const pcs = {};
const staff = [];
const monitors = [];
const activeTimers = {};

console.log('🚀 OFW-NET Server v2.2 starting...');
console.log(`📡 Server running on port ${PORT}`);
console.log(`🔐 Staff password: ${STAFF_PASSWORD === 'change_this_password' ? '⚠️ USING DEFAULT - CHANGE IT!' : '✅ Set'}`);
console.log(`🔐 Monitor password: ${MONITOR_PASSWORD === 'change_this_password' ? '⚠️ USING DEFAULT - CHANGE IT!' : '✅ Set'}`);

// ============================================================
// SERVER TIMER MANAGEMENT
// ============================================================

function startServerTimer(pcId, minutes) {
    // Clear any existing timer for this PC
    if (activeTimers[pcId]) {
        clearInterval(activeTimers[pcId]);
        delete activeTimers[pcId];
    }

    let remaining = minutes * 60;
    console.log(`⏱️ Starting server timer for ${pcId}: ${minutes} minutes`);

    if (pcs[pcId]) {
        pcs[pcId].timeRemaining = remaining;
        pcs[pcId].isRunning = true;
        pcs[pcId].status = 'running';
    }

    activeTimers[pcId] = setInterval(() => {
        remaining--;
        
        if (pcs[pcId]) {
            pcs[pcId].timeRemaining = remaining;
        }

        // Send timer update to client EVERY SECOND
        const pc = pcs[pcId];
        if (pc && pc.ws && pc.ws.readyState === WebSocket.OPEN) {
            try {
                pc.ws.send(JSON.stringify({
                    type: 'timer_update',
                    timeRemaining: remaining
                }));
            } catch (e) {
                // Socket might be closed
            }
        }

        // Broadcast status to staff/monitors every 5 seconds
        if (remaining % 5 === 0 || remaining <= 10) {
            broadcastToStaffAndMonitors({
                type: 'pc_status',
                pcId: pcId,
                status: 'running',
                timeRemaining: remaining,
                session: pcs[pcId] ? pcs[pcId].session : { minutes: 0, amount: 0 }
            });
        }

        // Time's up!
        if (remaining <= 0) {
            console.log(`⏰ Time's up for ${pcId}!`);
            clearInterval(activeTimers[pcId]);
            delete activeTimers[pcId];

            if (pcs[pcId]) {
                pcs[pcId].status = 'locked';
                pcs[pcId].timeRemaining = 0;
                pcs[pcId].isRunning = false;

                if (pcs[pcId].ws && pcs[pcId].ws.readyState === WebSocket.OPEN) {
                    try {
                        pcs[pcId].ws.send(JSON.stringify({
                            type: 'lock',
                            pcId: pcId
                        }));
                    } catch (e) {}
                }

                db.updateSessionEnd(pcId, 'expired');
                db.updatePCStatus(pcId, 'locked', 0, 0, 0);
                db.logAction(pcId, 'session_expired', 'Time ran out');

                broadcastToStaffAndMonitors({
                    type: 'session_expired',
                    pcId: pcId
                });

                broadcastToStaffAndMonitors({
                    type: 'pc_status',
                    pcId: pcId,
                    status: 'locked',
                    timeRemaining: 0,
                    session: { minutes: 0, amount: 0 }
                });
            }
        }
    }, 1000);
}

// ============================================================
// WEBSOCKET CONNECTION HANDLER
// ============================================================

wss.on('connection', (ws, req) => {
    let pcId = null;
    let isStaff = false;
    let isMonitor = false;
    const clientIP = req.socket.remoteAddress || 'unknown';

    console.log(`📡 New connection from ${clientIP}`);

    // Keep connection alive - ping every 10 seconds (Render friendly)
    const pingInterval = setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) {
            try {
                ws.send(JSON.stringify({ type: 'ping' }));
            } catch (e) {
                // Socket might be closed
            }
        }
    }, 10000);

    ws.on('message', async (message) => {
        try {
            const data = JSON.parse(message);
            console.log(`📩 [${pcId || 'unknown'}] Received:`, data.type);

            // ============================================================
            // REGISTER PC
            // ============================================================
            if (data.type === 'register') {
                pcId = data.pcId;
                pcs[pcId] = {
                    ws,
                    pcId,
                    status: data.status || 'idle',
                    timeRemaining: data.timeRemaining || 0,
                    pendingPayment: null,
                    session: { minutes: 0, amount: 0 },
                    isRunning: data.status === 'running',
                    online: true,
                    lastSeen: Date.now()
                };

                await db.updatePCStatus(pcId, data.status || 'idle', data.timeRemaining || 0);
                await db.logAction(pcId, 'pc_connected', `Connected from ${clientIP}`);

                console.log(`✅ PC ${pcId} registered`);

                broadcastToStaffAndMonitors({
                    type: 'pc_status',
                    pcId,
                    status: data.status || 'idle',
                    timeRemaining: data.timeRemaining || 0,
                    session: { minutes: 0, amount: 0 }
                });

                ws.send(JSON.stringify({
                    type: 'welcome',
                    pcId: pcId,
                    message: 'Connected to OFW-NET Server'
                }));
            }

            // ============================================================
            // STAFF LOGIN
            // ============================================================
            if (data.type === 'staff_login') {
                if (data.password === STAFF_PASSWORD) {
                    isStaff = true;
                    staff.push(ws);
                    console.log('✅ Staff logged in');

                    // Send all existing PC statuses
                    Object.keys(pcs).forEach(id => {
                        const pc = pcs[id];
                        try {
                            ws.send(JSON.stringify({
                                type: 'pc_status',
                                pcId: id,
                                status: pc.status || 'idle',
                                timeRemaining: pc.timeRemaining || 0,
                                pendingPayment: pc.pendingPayment || null,
                                session: pc.session || { minutes: 0, amount: 0 }
                            }));
                        } catch (e) {}
                    });

                    await db.logAction('STAFF', 'staff_login', 'Staff panel connected');
                } else {
                    ws.send(JSON.stringify({ 
                        type: 'error', 
                        message: 'Invalid staff password' 
                    }));
                }
            }

            // ============================================================
            // MONITOR LOGIN
            // ============================================================
            if (data.type === 'monitor_login') {
                if (data.password === MONITOR_PASSWORD) {
                    isMonitor = true;
                    monitors.push(ws);
                    console.log('✅ Monitor logged in');

                    Object.keys(pcs).forEach(id => {
                        const pc = pcs[id];
                        try {
                            ws.send(JSON.stringify({
                                type: 'pc_status',
                                pcId: id,
                                status: pc.status || 'idle',
                                timeRemaining: pc.timeRemaining || 0,
                                pendingPayment: pc.pendingPayment || null,
                                session: pc.session || { minutes: 0, amount: 0 }
                            }));
                        } catch (e) {}
                    });

                    await db.logAction('MONITOR', 'monitor_login', 'Monitor connected');
                } else {
                    ws.send(JSON.stringify({ 
                        type: 'error', 
                        message: 'Invalid monitor password' 
                    }));
                }
            }

            // ============================================================
            // PAYMENT REQUEST
            // ============================================================
            if (data.type === 'payment_request') {
                console.log(`💰 Payment request from ${data.pcId}: ₱${data.amount} (${data.minutes}min)`);
                
                if (!pcs[data.pcId]) {
                    console.log(`❌ PC ${data.pcId} not found`);
                    return;
                }

                const pc = pcs[data.pcId];
                
                try {
                    const payment = await db.savePayment(data.pcId, data.amount, data.minutes);
                    
                    pc.pendingPayment = {
                        minutes: data.minutes,
                        amount: data.amount,
                        reference: payment.reference
                    };
                    pc.status = 'pending';

                    await db.logAction(data.pcId, 'payment_requested', `₱${data.amount} for ${data.minutes}min`);

                    // Broadcast to staff and monitors
                    broadcastToStaffAndMonitors({
                        type: 'payment_request',
                        pcId: data.pcId,
                        minutes: data.minutes,
                        amount: data.amount,
                        reference: payment.reference
                    });

                    // Send acknowledgment to client
                    ws.send(JSON.stringify({
                        type: 'payment_request_ack',
                        pcId: data.pcId,
                        status: 'pending'
                    }));

                    console.log(`✅ Payment request broadcasted to staff`);

                } catch (error) {
                    console.error('❌ Error processing payment request:', error);
                    ws.send(JSON.stringify({
                        type: 'error',
                        message: 'Payment request failed'
                    }));
                }
            }

            // ============================================================
            // CONFIRM PAYMENT - FIXED
            // ============================================================
            if (data.type === 'confirm_payment' && isStaff) {
                console.log(`🔑 Staff confirming payment for ${data.pcId}`);

                if (!pcs[data.pcId]) {
                    console.log(`❌ PC ${data.pcId} not found`);
                    ws.send(JSON.stringify({ 
                        type: 'error', 
                        message: 'PC not found' 
                    }));
                    return;
                }

                const pc = pcs[data.pcId];
                
                // Check if there's a pending payment
                if (!pc.pendingPayment) {
                    console.log(`❌ No pending payment for ${data.pcId}`);
                    ws.send(JSON.stringify({ 
                        type: 'error', 
                        message: 'No pending payment' 
                    }));
                    return;
                }

                // Get payment details
                const { minutes, amount } = pc.pendingPayment;
                
                // Clear pending payment
                pc.pendingPayment = null;
                pc.status = 'running';
                pc.isRunning = true;

                // Add to existing time or start new
                if (pc.timeRemaining > 0 && pc.isRunning) {
                    pc.timeRemaining += minutes * 60;
                    pc.session.minutes += minutes;
                    pc.session.amount += amount;
                    console.log(`➕ Added ${minutes}min to existing session. New total: ${Math.floor(pc.timeRemaining/60)}min`);
                } else {
                    pc.timeRemaining = minutes * 60;
                    pc.session = { minutes, amount };
                    console.log(`🆕 New session started on ${data.pcId}: ${minutes}min · ₱${amount}`);
                }

                try {
                    // Save to database
                    const session = await db.saveSession(data.pcId, pc.session.minutes, pc.session.amount, 'staff');
                    await db.logAction(data.pcId, 'session_started', `₱${amount} for ${minutes}min`);
                    await db.updatePCStatus(data.pcId, 'running', pc.timeRemaining, pc.session.minutes, pc.session.amount);

                    // CRITICAL: Send start_session to client with the time
                    if (pc.ws && pc.ws.readyState === WebSocket.OPEN) {
                        try {
                            pc.ws.send(JSON.stringify({
                                type: 'start_session',
                                pcId: data.pcId,
                                minutes: pc.session.minutes,
                                amount: pc.session.amount,
                                timeRemaining: pc.timeRemaining
                            }));
                            console.log(`📤 Sent start_session to ${data.pcId} with ${pc.timeRemaining}s`);
                        } catch (e) {
                            console.error('❌ Error sending start_session:', e);
                        }
                    } else {
                        console.log(`❌ PC ${data.pcId} WebSocket not open`);
                    }

                    // Send unlock to client
                    if (pc.ws && pc.ws.readyState === WebSocket.OPEN) {
                        try {
                            pc.ws.send(JSON.stringify({
                                type: 'unlock',
                                pcId: data.pcId
                            }));
                            console.log(`📤 Sent unlock to ${data.pcId}`);
                        } catch (e) {
                            console.error('❌ Error sending unlock:', e);
                        }
                    }

                    // Start the server timer
                    startServerTimer(data.pcId, Math.ceil(pc.timeRemaining / 60));

                    // Broadcast to staff and monitors
                    broadcastToStaffAndMonitors({
                        type: 'pc_status',
                        pcId: data.pcId,
                        status: 'running',
                        timeRemaining: pc.timeRemaining,
                        session: pc.session
                    });

                    broadcastToStaffAndMonitors({
                        type: 'log',
                        pcId: data.pcId,
                        action: '✅ Payment Confirmed - Session ' + (pc.session.minutes > minutes ? 'Extended' : 'Started'),
                        amount: `₱${amount} (+${minutes}min)`
                    });

                    // Send confirmation back to staff panel
                    ws.send(JSON.stringify({
                        type: 'confirm_success',
                        pcId: data.pcId,
                        message: 'Payment confirmed successfully! Timer started.'
                    }));

                    console.log(`✅ Session confirmed and timer started for ${data.pcId}`);

                } catch (error) {
                    console.error('❌ Error starting session:', error);
                    ws.send(JSON.stringify({
                        type: 'error',
                        message: 'Failed to start session: ' + error.message
                    }));
                }
            }

            // ============================================================
            // DECLINE PAYMENT
            // ============================================================
            if (data.type === 'decline_payment' && isStaff) {
                if (!pcs[data.pcId]) {
                    console.log(`❌ PC ${data.pcId} not found`);
                    return;
                }

                const pc = pcs[data.pcId];
                pc.pendingPayment = null;
                pc.status = 'idle';

                try {
                    await db.logAction(data.pcId, 'payment_declined', 'Declined by staff');

                    if (pc.ws && pc.ws.readyState === WebSocket.OPEN) {
                        pc.ws.send(JSON.stringify({
                            type: 'payment_declined',
                            pcId: data.pcId
                        }));
                    }

                    broadcastToStaffAndMonitors({
                        type: 'pc_status',
                        pcId: data.pcId,
                        status: 'idle',
                        timeRemaining: 0,
                        session: { minutes: 0, amount: 0 }
                    });

                    console.log(`❌ Payment declined for ${data.pcId}`);
                } catch (error) {
                    console.error('❌ Error declining payment:', error);
                }
            }

            // ============================================================
            // STATUS UPDATE
            // ============================================================
            if (data.type === 'status') {
                if (!pcs[data.pcId]) {
                    console.log(`⚠️ Status update from unknown PC: ${data.pcId}`);
                    return;
                }

                const pc = pcs[data.pcId];
                pc.status = data.status || pc.status;
                pc.timeRemaining = data.timeRemaining || 0;
                pc.lastSeen = Date.now();
                if (data.session) {
                    pc.session = data.session;
                }

                await db.updatePCStatus(
                    data.pcId, 
                    pc.status, 
                    pc.timeRemaining,
                    pc.session.minutes || 0,
                    pc.session.amount || 0
                );

                broadcastToStaffAndMonitors({
                    type: 'pc_status',
                    pcId: data.pcId,
                    status: pc.status,
                    timeRemaining: pc.timeRemaining,
                    pendingPayment: pc.pendingPayment || null,
                    session: pc.session || { minutes: 0, amount: 0 }
                });
            }

            // ============================================================
            // UNLOCK PC
            // ============================================================
            if (data.type === 'unlock' && isStaff) {
                if (!pcs[data.pcId]) {
                    console.log(`❌ PC ${data.pcId} not found`);
                    return;
                }

                const pc = pcs[data.pcId];
                pc.status = 'idle';
                pc.pendingPayment = null;

                try {
                    await db.logAction(data.pcId, 'unlocked', 'Unlocked by staff');
                    await db.updatePCStatus(data.pcId, 'idle', 0, 0, 0);

                    if (pc.ws && pc.ws.readyState === WebSocket.OPEN) {
                        pc.ws.send(JSON.stringify({
                            type: 'unlock',
                            pcId: data.pcId
                        }));
                    }

                    broadcastToStaffAndMonitors({
                        type: 'pc_status',
                        pcId: data.pcId,
                        status: 'idle',
                        timeRemaining: 0,
                        session: { minutes: 0, amount: 0 }
                    });

                    console.log(`🔓 Unlocked ${data.pcId}`);
                } catch (error) {
                    console.error('❌ Error unlocking PC:', error);
                }
            }

            // ============================================================
            // STOP SESSION
            // ============================================================
            if (data.type === 'stop_session' && isStaff) {
                if (!pcs[data.pcId]) {
                    console.log(`❌ PC ${data.pcId} not found`);
                    return;
                }

                const pc = pcs[data.pcId];
                pc.status = 'idle';
                pc.timeRemaining = 0;
                pc.isRunning = false;

                if (activeTimers[data.pcId]) {
                    clearInterval(activeTimers[data.pcId]);
                    delete activeTimers[data.pcId];
                }

                try {
                    await db.updateSessionEnd(data.pcId, 'stopped_by_staff');
                    await db.logAction(data.pcId, 'session_stopped', 'Stopped by staff');
                    await db.updatePCStatus(data.pcId, 'idle', 0, 0, 0);

                    if (pc.ws && pc.ws.readyState === WebSocket.OPEN) {
                        pc.ws.send(JSON.stringify({
                            type: 'stop_session',
                            pcId: data.pcId
                        }));
                    }

                    broadcastToStaffAndMonitors({
                        type: 'pc_status',
                        pcId: data.pcId,
                        status: 'idle',
                        timeRemaining: 0,
                        session: { minutes: 0, amount: 0 }
                    });

                    console.log(`⏹️ Stopped session on ${data.pcId}`);
                } catch (error) {
                    console.error('❌ Error stopping session:', error);
                }
            }

            // ============================================================
            // LOCK PC
            // ============================================================
            if (data.type === 'lock' && isStaff) {
                if (!pcs[data.pcId]) {
                    console.log(`❌ PC ${data.pcId} not found`);
                    return;
                }

                const pc = pcs[data.pcId];
                pc.status = 'locked';
                pc.timeRemaining = 0;
                pc.isRunning = false;

                try {
                    await db.logAction(data.pcId, 'locked', 'Locked by staff');
                    await db.updatePCStatus(data.pcId, 'locked', 0, 0, 0);

                    if (pc.ws && pc.ws.readyState === WebSocket.OPEN) {
                        pc.ws.send(JSON.stringify({
                            type: 'lock',
                            pcId: data.pcId
                        }));
                    }

                    broadcastToStaffAndMonitors({
                        type: 'pc_status',
                        pcId: data.pcId,
                        status: 'locked',
                        timeRemaining: 0,
                        session: { minutes: 0, amount: 0 }
                    });

                    console.log(`🔒 Locked ${data.pcId}`);
                } catch (error) {
                    console.error('❌ Error locking PC:', error);
                }
            }

            // ============================================================
            // SHUTDOWN ALL
            // ============================================================
            if (data.type === 'shutdown_all' && (isStaff || isMonitor)) {
                if (data.password !== STAFF_PASSWORD && data.password !== MONITOR_PASSWORD) {
                    ws.send(JSON.stringify({
                        type: 'error',
                        message: 'Invalid password'
                    }));
                    return;
                }

                console.log('⏻ Shutting down all PCs...');

                try {
                    await db.logAction('SYSTEM', 'shutdown_all', 'Shutdown all command executed');

                    Object.keys(pcs).forEach(id => {
                        const pc = pcs[id];
                        if (pc.ws && pc.ws.readyState === WebSocket.OPEN) {
                            pc.ws.send(JSON.stringify({
                                type: 'shutdown'
                            }));
                            console.log(`📤 Sent shutdown to ${id}`);
                        }
                    });

                    broadcastToStaffAndMonitors({
                        type: 'log',
                        pcId: 'SYSTEM',
                        action: '⏻ Shutdown All Command Executed',
                        amount: '-'
                    });
                } catch (error) {
                    console.error('❌ Error shutting down:', error);
                }
            }

            // ============================================================
            // PONG
            // ============================================================
            if (data.type === 'pong') {
                // Connection is alive
            }

            // ============================================================
            // REFRESH
            // ============================================================
            if (data.type === 'refresh') {
                Object.keys(pcs).forEach(id => {
                    const pc = pcs[id];
                    try {
                        ws.send(JSON.stringify({
                            type: 'pc_status',
                            pcId: id,
                            status: pc.status || 'idle',
                            timeRemaining: pc.timeRemaining || 0,
                            pendingPayment: pc.pendingPayment || null,
                            session: pc.session || { minutes: 0, amount: 0 }
                        }));
                    } catch (e) {}
                });
            }

        } catch (error) {
            console.error('❌ Error processing message:', error);
            console.error('Message was:', message);
            try {
                ws.send(JSON.stringify({
                    type: 'error',
                    message: 'Invalid message format'
                }));
            } catch (e) {}
        }
    });

    // ============================================================
    // CONNECTION CLOSE
    // ============================================================
    ws.on('close', () => {
        clearInterval(pingInterval);
        console.log(`📡 Connection closed for ${pcId || 'unknown'}`);

        if (pcId && pcs[pcId]) {
            pcs[pcId].online = false;
            pcs[pcId].lastSeen = Date.now();

            broadcastToStaffAndMonitors({
                type: 'pc_offline',
                pcId: pcId,
                status: 'offline'
            });

            db.updatePCStatus(pcId, 'offline', 0, 0, 0);
            db.logAction(pcId, 'pc_disconnected', 'Connection lost');
        }

        const staffIndex = staff.indexOf(ws);
        if (staffIndex > -1) staff.splice(staffIndex, 1);

        const monitorIndex = monitors.indexOf(ws);
        if (monitorIndex > -1) monitors.splice(monitorIndex, 1);
    });

    ws.on('error', (error) => {
        console.error('❌ WebSocket error:', error);
    });
});

// ============================================================
// BROADCAST FUNCTIONS
// ============================================================

function broadcastToStaffAndMonitors(data) {
    const allClients = [...staff, ...monitors];
    let sentCount = 0;

    allClients.forEach(s => {
        if (s && s.readyState === WebSocket.OPEN) {
            try {
                s.send(JSON.stringify(data));
                sentCount++;
            } catch (error) {
                // Socket might be closed
            }
        }
    });

    if (sentCount > 0) {
        console.log(`📤 Broadcasted ${data.type} to ${sentCount} staff/monitors`);
    }
}

// ============================================================
// START SERVER
// ============================================================

server.listen(PORT, () => {
    console.log(`🚀 Server running on ws://localhost:${PORT}`);
    console.log(`📊 Health check: http://localhost:${PORT}/health`);
    console.log(`📊 Status page: http://localhost:${PORT}/`);
});

// ============================================================
// GRACEFUL SHUTDOWN
// ============================================================
process.on('SIGTERM', () => {
    console.log('🛑 Received SIGTERM, shutting down gracefully...');
    Object.keys(activeTimers).forEach(key => {
        clearInterval(activeTimers[key]);
    });
    server.close(() => {
        db.db.close(() => {
            console.log('✅ Database closed');
            process.exit(0);
        });
    });
});