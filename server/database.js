// ============================================================
// OFW-NET DATABASE MODULE - Using better-sqlite3 v11
// ============================================================

const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

// Ensure data directory exists
const dataDir = path.join(__dirname, 'data');
if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
}

const dbPath = path.join(dataDir, 'pisonet.db');

// Open database in read-write mode, create if it doesn't exist
const db = new Database(dbPath, {
    verbose: console.log
});

console.log('📦 Database initialized at:', dbPath);

// ============================================================
// CREATE TABLES (Synchronous with better-sqlite3)
// ============================================================

db.exec(`
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

db.exec(`
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

db.exec(`
    CREATE TABLE IF NOT EXISTS logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        pcId TEXT NOT NULL,
        action TEXT NOT NULL,
        details TEXT,
        timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
    )
`);

db.exec(`
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

// ============================================================
// PREPARED STATEMENTS (Faster queries)
// ============================================================

const insertLog = db.prepare(`
    INSERT INTO logs (pcId, action, details) VALUES (?, ?, ?)
`);

const insertSession = db.prepare(`
    INSERT INTO sessions (pcId, minutes, amount, reference, staffConfirmed) 
    VALUES (?, ?, ?, ?, ?)
`);

const updateSessionEnd = db.prepare(`
    UPDATE sessions SET endTime = CURRENT_TIMESTAMP, status = ? 
    WHERE pcId = ? AND status = 'active'
`);

const insertPayment = db.prepare(`
    INSERT INTO payments (pcId, amount, minutes, reference) 
    VALUES (?, ?, ?, ?)
`);

const updatePayment = db.prepare(`
    UPDATE payments SET status = 'confirmed', confirmedAt = CURRENT_TIMESTAMP, confirmedBy = ? 
    WHERE reference = ?
`);

const upsertPCStatus = db.prepare(`
    INSERT INTO pc_status (pcId, status, timeRemaining, lastSeen, sessionMinutes, sessionAmount) 
    VALUES (?, ?, ?, CURRENT_TIMESTAMP, ?, ?)
    ON CONFLICT(pcId) DO UPDATE SET 
    status = excluded.status, 
    timeRemaining = excluded.timeRemaining, 
    lastSeen = CURRENT_TIMESTAMP,
    sessionMinutes = excluded.sessionMinutes,
    sessionAmount = excluded.sessionAmount
`);

// ============================================================
// HELPER FUNCTIONS (Async-friendly)
// ============================================================

function logAction(pcId, action, details = '') {
    try {
        const result = insertLog.run(pcId, action, details);
        return Promise.resolve(result.lastInsertRowid);
    } catch (err) {
        console.error('❌ Error logging action:', err);
        return Promise.reject(err);
    }
}

function saveSession(pcId, minutes, amount, staffId = 'staff') {
    try {
        const reference = `SESS-${Date.now()}-${pcId}`;
        const result = insertSession.run(pcId, minutes, amount, reference, staffId);
        return Promise.resolve({ id: result.lastInsertRowid, reference });
    } catch (err) {
        console.error('❌ Error saving session:', err);
        return Promise.reject(err);
    }
}

function updateSessionEnd(pcId, status = 'ended') {
    try {
        const result = updateSessionEnd.run(status, pcId);
        return Promise.resolve(result.changes);
    } catch (err) {
        console.error('❌ Error updating session:', err);
        return Promise.reject(err);
    }
}

function savePayment(pcId, amount, minutes) {
    try {
        const reference = `PAY-${Date.now()}-${pcId}`;
        const result = insertPayment.run(pcId, amount, minutes, reference);
        return Promise.resolve({ id: result.lastInsertRowid, reference });
    } catch (err) {
        console.error('❌ Error saving payment:', err);
        return Promise.reject(err);
    }
}

function confirmPayment(reference, confirmedBy = 'staff') {
    try {
        const result = updatePayment.run(confirmedBy, reference);
        return Promise.resolve(result.changes);
    } catch (err) {
        console.error('❌ Error confirming payment:', err);
        return Promise.reject(err);
    }
}

function updatePCStatus(pcId, status, timeRemaining = 0, sessionMinutes = 0, sessionAmount = 0) {
    try {
        const result = upsertPCStatus.run(pcId, status, timeRemaining, sessionMinutes, sessionAmount);
        return Promise.resolve(result.changes);
    } catch (err) {
        console.error('❌ Error updating PC status:', err);
        return Promise.reject(err);
    }
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
    updatePCStatus
};

console.log('🗄️ Database module loaded successfully');