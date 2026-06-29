// ============================================================
// OFW-NET DATABASE MODULE
// Handles all database operations using SQLite
// ============================================================

const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const fs = require('fs');

// Ensure data directory exists
const dataDir = path.join(__dirname, 'data');
if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
}

const dbPath = path.join(dataDir, 'pisonet.db');
const db = new sqlite3.Database(dbPath);

console.log('📦 Database initialized at:', dbPath);

// ============================================================
// CREATE TABLES
// ============================================================
db.serialize(() => {
    // 1. Sessions table - tracks all PC sessions
    db.run(`
        CREATE TABLE IF NOT EXISTS sessions (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            pcId TEXT NOT NULL,
            minutes INTEGER NOT NULL,
            amount REAL NOT NULL,
            startTime DATETIME DEFAULT CURRENT_TIMESTAMP,
            endTime DATETIME,
            status TEXT DEFAULT 'active',
            reference TEXT UNIQUE,
            staffConfirmed TEXT
        )
    `);

    // 2. Payments table - tracks all payment requests
    db.run(`
        CREATE TABLE IF NOT EXISTS payments (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            pcId TEXT NOT NULL,
            amount REAL NOT NULL,
            minutes INTEGER NOT NULL,
            status TEXT DEFAULT 'pending',
            reference TEXT UNIQUE,
            createdAt DATETIME DEFAULT CURRENT_TIMESTAMP,
            confirmedAt DATETIME,
            confirmedBy TEXT
        )
    `);

    // 3. Logs table - tracks all system activities
    db.run(`
        CREATE TABLE IF NOT EXISTS logs (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            pcId TEXT NOT NULL,
            action TEXT NOT NULL,
            details TEXT,
            timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
        )
    `);

    // 4. PC status table - tracks last known status of each PC
    db.run(`
        CREATE TABLE IF NOT EXISTS pc_status (
            pcId TEXT PRIMARY KEY,
            status TEXT DEFAULT 'idle',
            timeRemaining INTEGER DEFAULT 0,
            lastSeen DATETIME DEFAULT CURRENT_TIMESTAMP,
            sessionMinutes INTEGER DEFAULT 0,
            sessionAmount REAL DEFAULT 0
        )
    `);

    console.log('✅ Database tables created/verified');
});

// ============================================================
// HELPER FUNCTIONS
// ============================================================

/**
 * Log an action to the database
 */
function logAction(pcId, action, details = '') {
    return new Promise((resolve, reject) => {
        db.run(
            'INSERT INTO logs (pcId, action, details) VALUES (?, ?, ?)',
            [pcId, action, details],
            function(err) {
                if (err) {
                    console.error('❌ Error logging action:', err);
                    reject(err);
                } else {
                    resolve(this.lastID);
                }
            }
        );
    });
}

/**
 * Save a new session
 */
function saveSession(pcId, minutes, amount, staffId = 'staff') {
    return new Promise((resolve, reject) => {
        const reference = `SESS-${Date.now()}-${pcId}`;
        db.run(
            'INSERT INTO sessions (pcId, minutes, amount, reference, staffConfirmed) VALUES (?, ?, ?, ?, ?)',
            [pcId, minutes, amount, reference, staffId],
            function(err) {
                if (err) {
                    console.error('❌ Error saving session:', err);
                    reject(err);
                } else {
                    resolve({ id: this.lastID, reference });
                }
            }
        );
    });
}

/**
 * Update session end time
 */
function updateSessionEnd(pcId, status = 'ended') {
    return new Promise((resolve, reject) => {
        db.run(
            'UPDATE sessions SET endTime = CURRENT_TIMESTAMP, status = ? WHERE pcId = ? AND status = "active"',
            [status, pcId],
            function(err) {
                if (err) {
                    console.error('❌ Error updating session:', err);
                    reject(err);
                } else {
                    resolve(this.changes);
                }
            }
        );
    });
}

/**
 * Save a payment request
 */
function savePayment(pcId, amount, minutes) {
    return new Promise((resolve, reject) => {
        const reference = `PAY-${Date.now()}-${pcId}`;
        db.run(
            'INSERT INTO payments (pcId, amount, minutes, reference) VALUES (?, ?, ?, ?)',
            [pcId, amount, minutes, reference],
            function(err) {
                if (err) {
                    console.error('❌ Error saving payment:', err);
                    reject(err);
                } else {
                    resolve({ id: this.lastID, reference });
                }
            }
        );
    });
}

/**
 * Confirm a payment
 */
function confirmPayment(reference, confirmedBy = 'staff') {
    return new Promise((resolve, reject) => {
        db.run(
            'UPDATE payments SET status = "confirmed", confirmedAt = CURRENT_TIMESTAMP, confirmedBy = ? WHERE reference = ?',
            [confirmedBy, reference],
            function(err) {
                if (err) {
                    console.error('❌ Error confirming payment:', err);
                    reject(err);
                } else {
                    resolve(this.changes);
                }
            }
        );
    });
}

/**
 * Get session history for a PC
 */
function getSessionHistory(pcId, limit = 50) {
    return new Promise((resolve, reject) => {
        db.all(
            'SELECT * FROM sessions WHERE pcId = ? ORDER BY startTime DESC LIMIT ?',
            [pcId, limit],
            (err, rows) => {
                if (err) {
                    console.error('❌ Error getting history:', err);
                    reject(err);
                } else {
                    resolve(rows);
                }
            }
        );
    });
}

/**
 * Get all logs
 */
function getLogs(limit = 100) {
    return new Promise((resolve, reject) => {
        db.all(
            'SELECT * FROM logs ORDER BY timestamp DESC LIMIT ?',
            [limit],
            (err, rows) => {
                if (err) {
                    console.error('❌ Error getting logs:', err);
                    reject(err);
                } else {
                    resolve(rows);
                }
            }
        );
    });
}

/**
 * Update PC status
 */
function updatePCStatus(pcId, status, timeRemaining = 0, sessionMinutes = 0, sessionAmount = 0) {
    return new Promise((resolve, reject) => {
        db.run(
            `INSERT INTO pc_status (pcId, status, timeRemaining, lastSeen, sessionMinutes, sessionAmount) 
             VALUES (?, ?, ?, CURRENT_TIMESTAMP, ?, ?)
             ON CONFLICT(pcId) DO UPDATE SET 
             status = ?, timeRemaining = ?, lastSeen = CURRENT_TIMESTAMP, 
             sessionMinutes = ?, sessionAmount = ?`,
            [pcId, status, timeRemaining, sessionMinutes, sessionAmount, 
             status, timeRemaining, sessionMinutes, sessionAmount],
            function(err) {
                if (err) {
                    console.error('❌ Error updating PC status:', err);
                    reject(err);
                } else {
                    resolve(this.changes);
                }
            }
        );
    });
}

/**
 * Get daily sales summary
 */
function getDailySales(date = null) {
    return new Promise((resolve, reject) => {
        const dateFilter = date || new Date().toISOString().split('T')[0];
        db.get(
            `SELECT 
                COUNT(*) as totalSessions,
                SUM(amount) as totalAmount,
                SUM(minutes) as totalMinutes
             FROM sessions 
             WHERE DATE(startTime) = ? AND status = 'ended'`,
            [dateFilter],
            (err, row) => {
                if (err) {
                    console.error('❌ Error getting daily sales:', err);
                    reject(err);
                } else {
                    resolve(row || { totalSessions: 0, totalAmount: 0, totalMinutes: 0 });
                }
            }
        );
    });
}

// ============================================================
// EXPORT MODULE
// ============================================================
module.exports = {
    db,
    logAction,
    saveSession,
    updateSessionEnd,
    savePayment,
    confirmPayment,
    getSessionHistory,
    getLogs,
    updatePCStatus,
    getDailySales
};

console.log('🗄️ Database module loaded successfully');