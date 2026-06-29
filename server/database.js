// ============================================================
// OFW-NET DATABASE MODULE - Using sql.js (Pure JavaScript)
// ============================================================

const initSqlJs = require('sql.js');
const fs = require('fs');
const path = require('path');

// Ensure data directory exists
const dataDir = path.join(__dirname, 'data');
if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
}

const dbPath = path.join(dataDir, 'pisonet.db');

// Database instance
let db = null;

// ============================================================
// INITIALIZE DATABASE - FIXED VERSION
// ============================================================

async function initDatabase() {
    try {
        // ✅ FIX: Use local wasm file from node_modules
        const SQL = await initSqlJs({
            locateFile: () => {
                return path.join(__dirname, 'node_modules', 'sql.js', 'dist', 'sql-wasm.wasm');
            }
        });

        // Try to load existing database, or create new one
        let data = null;
        if (fs.existsSync(dbPath)) {
            data = fs.readFileSync(dbPath);
        }

        db = new SQL.Database(data);

        // Create tables
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

        db.run(`
            CREATE TABLE IF NOT EXISTS logs (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                pcId TEXT NOT NULL,
                action TEXT NOT NULL,
                details TEXT,
                timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
            )
        `);

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
        saveDatabase();
        return db;
    } catch (err) {
        console.error('❌ Error initializing database:', err);
        throw err;
    }
}

// ============================================================
// SAVE DATABASE TO DISK
// ============================================================

function saveDatabase() {
    if (db) {
        const data = db.export();
        const buffer = Buffer.from(data);
        fs.writeFileSync(dbPath, buffer);
    }
}

// ============================================================
// WRAPPER FUNCTIONS
// ============================================================

function logAction(pcId, action, details = '') {
    try {
        const stmt = db.prepare(`
            INSERT INTO logs (pcId, action, details) VALUES (?, ?, ?)
        `);
        stmt.run(pcId, action, details);
        stmt.free();
        saveDatabase();
        return Promise.resolve();
    } catch (err) {
        console.error('❌ Error logging action:', err);
        return Promise.reject(err);
    }
}

function saveSession(pcId, minutes, amount, staffId = 'staff') {
    try {
        const reference = `SESS-${Date.now()}-${pcId}`;
        const stmt = db.prepare(`
            INSERT INTO sessions (pcId, minutes, amount, reference, staffConfirmed) 
            VALUES (?, ?, ?, ?, ?)
        `);
        stmt.run(pcId, minutes, amount, reference, staffId);
        stmt.free();
        saveDatabase();
        return Promise.resolve({ reference });
    } catch (err) {
        console.error('❌ Error saving session:', err);
        return Promise.reject(err);
    }
}

function updateSessionEnd(pcId, status = 'ended') {
    try {
        const stmt = db.prepare(`
            UPDATE sessions SET endTime = CURRENT_TIMESTAMP, status = ? 
            WHERE pcId = ? AND status = 'active'
        `);
        const result = stmt.run(status, pcId);
        stmt.free();
        saveDatabase();
        return Promise.resolve(result.changes);
    } catch (err) {
        console.error('❌ Error updating session:', err);
        return Promise.reject(err);
    }
}

function savePayment(pcId, amount, minutes) {
    try {
        const reference = `PAY-${Date.now()}-${pcId}`;
        const stmt = db.prepare(`
            INSERT INTO payments (pcId, amount, minutes, reference) 
            VALUES (?, ?, ?, ?)
        `);
        stmt.run(pcId, amount, minutes, reference);
        stmt.free();
        saveDatabase();
        return Promise.resolve({ reference });
    } catch (err) {
        console.error('❌ Error saving payment:', err);
        return Promise.reject(err);
    }
}

function confirmPayment(reference, confirmedBy = 'staff') {
    try {
        const stmt = db.prepare(`
            UPDATE payments SET status = 'confirmed', confirmedAt = CURRENT_TIMESTAMP, confirmedBy = ? 
            WHERE reference = ?
        `);
        const result = stmt.run(confirmedBy, reference);
        stmt.free();
        saveDatabase();
        return Promise.resolve(result.changes);
    } catch (err) {
        console.error('❌ Error confirming payment:', err);
        return Promise.reject(err);
    }
}

function updatePCStatus(pcId, status, timeRemaining = 0, sessionMinutes = 0, sessionAmount = 0) {
    try {
        const stmt = db.prepare(`
            INSERT INTO pc_status (pcId, status, timeRemaining, lastSeen, sessionMinutes, sessionAmount) 
            VALUES (?, ?, ?, CURRENT_TIMESTAMP, ?, ?)
            ON CONFLICT(pcId) DO UPDATE SET 
            status = excluded.status, 
            timeRemaining = excluded.timeRemaining, 
            lastSeen = CURRENT_TIMESTAMP,
            sessionMinutes = excluded.sessionMinutes,
            sessionAmount = excluded.sessionAmount
        `);
        stmt.run(pcId, status, timeRemaining, sessionMinutes, sessionAmount);
        stmt.free();
        saveDatabase();
        return Promise.resolve();
    } catch (err) {
        console.error('❌ Error updating PC status:', err);
        return Promise.reject(err);
    }
}

// ============================================================
// INITIALIZE AND EXPORT
// ============================================================

async function initialize() {
    await initDatabase();
    console.log('🗄️ Database module loaded successfully');
    return db;
}

module.exports = {
    initialize,
    logAction,
    saveSession,
    updateSessionEnd,
    savePayment,
    confirmPayment,
    updatePCStatus,
    get db() { return db; }
};