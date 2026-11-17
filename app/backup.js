// backup.js - consistent database backups with SQLite's VACUUM INTO.
//
// Used two ways:
//   1. by the web app (button on /admin), and
//   2. from the command line while the app is running:
//        docker exec wedding-web-1 node /app/backup.js
//
// VACUUM INTO writes a complete, consistent copy of the database to a new
// file, even while the app keeps running (it reads inside a transaction).
// Copying app.db with a file manager while the app is writing could produce
// a broken copy; this cannot.
//
// Files: ${DATA_DIR}/backups/app-YYYYMMDD-HHMMSS.db (UTC time). If two
// backups are made within the same second, the second gets "-1", "-2", ...
// Only files matching that pattern are counted and pruned; anything else in
// the folder is left alone. The newest BACKUPS_TO_KEEP are kept.

'use strict';

const fs = require('node:fs');
const path = require('node:path');

const NAME_RE = /^app-(\d{8})-(\d{6})(?:-(\d+))?\.db$/;

// "2026-11-16T14:03:09.123Z" -> "20261116-140309"
function stamp(date) {
  return date.toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
}

// Sort key that orders backups oldest -> newest (the counter suffix is padded
// so app-...-2.db sorts before app-...-10.db).
function sortKey(name) {
  const m = NAME_RE.exec(name);
  return `${m[1]}${m[2]}${String(m[3] || 0).padStart(6, '0')}`;
}

// Backups in backupDir, newest first: [{ name, file, size, mtime }]
function listBackups(backupDir) {
  if (!fs.existsSync(backupDir)) return [];
  return fs
    .readdirSync(backupDir)
    .filter((name) => NAME_RE.test(name))
    .sort((a, b) => sortKey(b).localeCompare(sortKey(a)))
    .map((name) => {
      const file = path.join(backupDir, name);
      const st = fs.statSync(file);
      return { name, file, size: st.size, mtime: st.mtime.toISOString().replace('T', ' ').slice(0, 19) };
    });
}

// Write a new backup and delete the oldest ones beyond `keep`.
// Returns { file, deleted: [names] }.
function createBackup(db, backupDir, keep) {
  fs.mkdirSync(backupDir, { recursive: true });
  // Name: app-YYYYMMDD-HHMMSS.db, or with -N if that second is already used.
  // N is one more than the highest N so far, so a new backup always sorts as
  // the newest, even if older ones from the same second were already pruned.
  const base = `app-${stamp(new Date())}`;
  const sameSecond = fs
    .readdirSync(backupDir)
    .map((name) => NAME_RE.exec(name))
    .filter((m) => m && `app-${m[1]}-${m[2]}` === base)
    .map((m) => Number(m[3] || 0));
  const name = sameSecond.length === 0 ? `${base}.db` : `${base}-${Math.max(...sameSecond) + 1}.db`;
  const file = path.join(backupDir, name);

  db.prepare('VACUUM INTO ?').run(file);

  const deleted = [];
  for (const old of listBackups(backupDir).slice(keep)) {
    fs.unlinkSync(old.file);
    deleted.push(old.name);
  }
  return { file, deleted };
}

module.exports = { createBackup, listBackups, NAME_RE };

// ---------------------------------------------------------------------------
// Command-line use: node /app/backup.js
// ---------------------------------------------------------------------------
if (require.main === module) {
  const config = require('./config');
  const { becomeDataOwner } = require('./perms');
  const { openDatabase } = require('./db');

  try {
    if (!fs.existsSync(config.DB_FILE)) throw new Error(`database not found: ${config.DB_FILE}`);
    // `docker exec` runs this as root. Switch to the owner of the data folder
    // (normally the node user, uid 1000) first, so the backup file and folder
    // are owned like the rest of /data and the web app can manage them.
    const owner = becomeDataOwner(config.DATA_DIR);
    if (owner) console.log(`running as uid ${owner.uid} (owner of ${config.DATA_DIR})`);

    // Read-only: this process never writes to app.db, so it cannot leave
    // files with the wrong owner next to it.
    const db = openDatabase(config.DB_FILE, { readOnly: true });
    const { file, deleted } = createBackup(db, config.BACKUP_DIR, config.BACKUPS_TO_KEEP);
    db.close();

    console.log(`backup written: ${file}`);
    for (const name of deleted) console.log(`deleted old backup: ${name}`);
    const all = listBackups(config.BACKUP_DIR);
    console.log(`${all.length} backup(s) in ${config.BACKUP_DIR}:`);
    for (const b of all) console.log(`  ${b.name}  ${b.size} bytes  ${b.mtime} UTC`);
  } catch (err) {
    console.error(`backup failed: ${err.message}`);
    process.exit(1);
  }
}
