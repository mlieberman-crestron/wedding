// db.js - open the SQLite database and bring its schema up to date.
//
// Schema changes are numbered "migrations". The table schema_version records
// which ones have been applied. At startup migrate() runs every migration
// that is not recorded yet, each inside its own transaction: either the whole
// migration and its schema_version row are written, or nothing is.
// Running migrate() again does nothing, so it is safe on every start.
//
// Rules for future changes: never edit a migration that has been released;
// add a new one with the next number instead.

'use strict';

const { DatabaseSync } = require('node:sqlite');

function openDatabase(file, { readOnly = false } = {}) {
  const db = new DatabaseSync(file, { readOnly });
  // Foreign keys are off by default in SQLite; switch them on per connection.
  // busy_timeout: if another connection (e.g. backup.js) holds a lock, wait up
  // to 5 s instead of failing immediately with "database is locked".
  db.exec('PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
  return db;
}

// Run fn() inside a transaction. IMMEDIATE takes the write lock at the start,
// so two processes cannot apply the same migration at the same time.
function transaction(db, fn) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    try {
      db.exec('ROLLBACK');
    } catch {
      // ignore: the original error is the interesting one
    }
    throw err;
  }
}

const nowIso = () => new Date().toISOString(); // UTC, e.g. 2026-11-16T14:03:00.000Z

// ---------------------------------------------------------------------------
// Migrations. ctx = { eventName } (values some migrations need).
// Every statement is written so that running it twice is harmless
// (IF NOT EXISTS / WHERE NOT EXISTS), as a second line of defence.
// ---------------------------------------------------------------------------
const MIGRATIONS = [
  {
    version: 1,
    name: 'adopt 0.1.0 visit counter',
    // Version 0.1.0 created this table without any version tracking. On a
    // 0.1.0 database it already exists (with the visit count in it) and this
    // statement leaves it untouched; on a new database it creates it.
    up(db) {
      db.exec(`CREATE TABLE IF NOT EXISTS counter (
        name  TEXT PRIMARY KEY,
        value INTEGER NOT NULL
      )`);
    },
  },
  {
    version: 2,
    name: 'events and guests',
    up(db, ctx) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS events (
          id         INTEGER PRIMARY KEY,
          name       TEXT NOT NULL,
          created_at TEXT NOT NULL            -- UTC ISO 8601
        );

        CREATE TABLE IF NOT EXISTS guests (
          id         INTEGER PRIMARY KEY,
          event_id   INTEGER NOT NULL REFERENCES events(id),
          first_name TEXT NOT NULL DEFAULT '',
          last_name  TEXT NOT NULL DEFAULT '',
          household  TEXT NOT NULL DEFAULT '',
          email      TEXT NOT NULL DEFAULT '',
          phone      TEXT NOT NULL DEFAULT '',
          side       TEXT NOT NULL DEFAULT '' CHECK (side IN ('', 'a', 'b', 'both')),
          notes      TEXT NOT NULL DEFAULT '',
          created_at TEXT NOT NULL,           -- UTC ISO 8601
          updated_at TEXT NOT NULL,           -- UTC ISO 8601
          CHECK (first_name <> '' OR last_name <> '')
        );

        CREATE INDEX IF NOT EXISTS guests_event_name
          ON guests (event_id, last_name, first_name);
      `);
      // One container serves one wedding: seed its event row.
      db.prepare(
        'INSERT INTO events (name, created_at) SELECT ?, ? WHERE NOT EXISTS (SELECT 1 FROM events)'
      ).run(ctx.eventName, nowIso());
    },
  },
  {
    version: 3,
    name: 'admin sessions',
    // Stored in the database (not in memory) so logins survive a restart.
    // id is the SHA-256 of the cookie value, so the table alone cannot be
    // used to log in.
    up(db) {
      db.exec(`CREATE TABLE IF NOT EXISTS sessions (
        id         TEXT PRIMARY KEY,
        csrf_token TEXT NOT NULL,
        created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL
      )`);
    },
  },
];

const LATEST_VERSION = MIGRATIONS[MIGRATIONS.length - 1].version;

function schemaVersion(db) {
  const row = db.prepare('SELECT MAX(version) AS v FROM schema_version').get();
  return row.v || 0;
}

// Apply missing migrations. log(message) is called for each one applied.
// Returns the schema version afterwards.
function migrate(db, ctx, log = () => {}) {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_version (
    version    INTEGER PRIMARY KEY,
    name       TEXT NOT NULL,
    applied_at TEXT NOT NULL
  )`);

  const current = schemaVersion(db);
  if (current > LATEST_VERSION) {
    // The database was written by a newer version of the app. Refuse to run
    // rather than risk damaging data we do not understand.
    throw new Error(
      `database schema version ${current} is newer than this app supports (${LATEST_VERSION}); ` +
        'install the newer app version or restore an older backup'
    );
  }

  const isApplied = db.prepare('SELECT 1 FROM schema_version WHERE version = ?');
  const record = db.prepare('INSERT INTO schema_version (version, name, applied_at) VALUES (?, ?, ?)');
  for (const m of MIGRATIONS) {
    transaction(db, () => {
      if (isApplied.get(m.version)) return; // already done (checked inside the lock)
      m.up(db, ctx);
      record.run(m.version, m.name, nowIso());
      log(`applied migration ${m.version}: ${m.name}`);
    });
  }
  return schemaVersion(db);
}

module.exports = { openDatabase, transaction, migrate, schemaVersion, LATEST_VERSION, MIGRATIONS, nowIso };
