// Tests for app/db.js migrations and the guest data-access functions.
// Each test uses its own database file in a temporary folder.
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { openDatabase, migrate, schemaVersion, LATEST_VERSION } = require('../app/db');
const guests = require('../app/guests');
const { createBackup, listBackups } = require('../app/backup');

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'wedding-test-'));
}

const tables = (db) => db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all().map((r) => r.name);

// Exactly what version 0.1.0 created: a counter table, no version tracking.
function create010Database(file, visits) {
  const db = new DatabaseSync(file);
  db.exec(`CREATE TABLE IF NOT EXISTS counter (
    name  TEXT PRIMARY KEY,
    value INTEGER NOT NULL
  )`);
  db.prepare("INSERT INTO counter (name, value) VALUES ('visits', ?)").run(visits);
  db.close();
}

test('upgrading a 0.1.0 database keeps the visit count and adds the new tables', () => {
  const file = path.join(tempDir(), 'app.db');
  create010Database(file, 42);

  const db = openDatabase(file);
  const applied = [];
  assert.equal(migrate(db, { eventName: 'Test Event' }, (m) => applied.push(m)), LATEST_VERSION);
  assert.equal(applied.length, LATEST_VERSION);

  assert.equal(db.prepare("SELECT value FROM counter WHERE name = 'visits'").get().value, 42);
  for (const t of ['counter', 'events', 'guests', 'schema_version', 'sessions']) assert.ok(tables(db).includes(t), t);
  const events = db.prepare('SELECT name FROM events').all();
  assert.deepEqual(events.map((e) => e.name), ['Test Event']);
  assert.ok(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = 'guests_event_name'").get());
  db.close();
});

test('migrations are idempotent: running again changes nothing', () => {
  const file = path.join(tempDir(), 'app.db');
  create010Database(file, 7);

  let db = openDatabase(file);
  migrate(db, { eventName: 'E' });
  db.close();

  // Second run in a new connection, as after a container restart.
  db = openDatabase(file);
  const applied = [];
  assert.equal(migrate(db, { eventName: 'Other name' }, (m) => applied.push(m)), LATEST_VERSION);
  assert.deepEqual(applied, [], 'nothing applied the second time');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM events').get().n, 1, 'event not seeded twice');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM schema_version').get().n, LATEST_VERSION);
  assert.equal(db.prepare("SELECT value FROM counter WHERE name = 'visits'").get().value, 7);
  db.close();
});

test('a brand-new database is created from scratch', () => {
  const db = openDatabase(path.join(tempDir(), 'app.db'));
  assert.equal(migrate(db, { eventName: 'New' }), LATEST_VERSION);
  assert.equal(schemaVersion(db), LATEST_VERSION);
  db.close();
});

test('a database from a newer app version is refused', () => {
  const db = openDatabase(path.join(tempDir(), 'app.db'));
  migrate(db, { eventName: 'E' });
  db.prepare("INSERT INTO schema_version VALUES (999, 'future', 'x')").run();
  assert.throws(() => migrate(db, { eventName: 'E' }), /newer than this app/);
  db.close();
});

test('foreign keys are enforced and the guests table checks its values', () => {
  const db = openDatabase(path.join(tempDir(), 'app.db'));
  migrate(db, { eventName: 'E' });
  const g = { first_name: 'A', last_name: '', household: '', email: '', phone: '', side: '', notes: '' };
  assert.throws(() => guests.insertGuest(db, 999, g), /FOREIGN KEY/);
  assert.throws(() => guests.insertGuest(db, 1, { ...g, side: 'x' }), /CHECK/);
  assert.throws(() => guests.insertGuest(db, 1, { ...g, first_name: '' }), /CHECK/);
  db.close();
});

test('guest data access: insert, search, counts, update, delete, import transaction', () => {
  const db = openDatabase(path.join(tempDir(), 'app.db'));
  migrate(db, { eventName: 'E' });
  const base = { household: '', email: '', phone: '', notes: '' };
  const id = guests.insertGuest(db, 1, { ...base, first_name: 'Zoe', last_name: 'Adams', side: 'a' });
  guests.insertGuest(db, 1, { ...base, first_name: 'amy', last_name: 'baker', side: 'both', email: 'amy_50%@example.com' });

  assert.deepEqual(guests.listGuests(db, 1).map((x) => x.last_name), ['Adams', 'baker'], 'sorted by last name, case-insensitive');
  assert.equal(guests.listGuests(db, 1, 'zoe adams').length, 1, 'full-name search');
  assert.equal(guests.listGuests(db, 1, '50%').length, 1, 'literal % in search');
  assert.equal(guests.listGuests(db, 1, '5_%').length, 0, 'wildcards escaped');
  assert.deepEqual(guests.countBySide(db, 1), { total: 2, a: 1, b: 0, both: 1, none: 0 });

  assert.equal(guests.updateGuest(db, 1, id, { ...base, first_name: 'Zoe', last_name: 'Adams', side: 'b' }), true);
  assert.equal(guests.getGuest(db, 1, id).side, 'b');
  assert.equal(guests.getGuest(db, 2, id), undefined, 'other event cannot see it');
  assert.equal(guests.deleteGuest(db, 1, id), true);

  // One bad row makes the whole import roll back.
  const good = { ...base, first_name: 'Ok', last_name: '', side: '' };
  assert.throws(() => guests.importGuests(db, 1, [good, { ...good, side: 'invalid' }]));
  assert.equal(guests.countBySide(db, 1).total, 1, 'nothing from the failed import was kept');
  assert.equal(guests.importGuests(db, 1, [good, good]), 2);
  db.close();
});

test('backups: VACUUM INTO copy, retention keeps the newest', () => {
  const dir = tempDir();
  const db = openDatabase(path.join(dir, 'app.db'));
  migrate(db, { eventName: 'E' });
  const backupDir = path.join(dir, 'backups');
  fs.mkdirSync(backupDir);
  fs.writeFileSync(path.join(backupDir, 'keep-me.txt'), 'not a backup');
  // Many backups in quick succession (usually within one second): each new
  // one must survive pruning, i.e. always be the newest.
  for (let i = 0; i < 8; i++) {
    const { file } = createBackup(db, backupDir, 3);
    assert.ok(fs.existsSync(file), `backup ${i + 1} still exists after pruning`);
    assert.equal(listBackups(backupDir)[0].file, file, 'new backup is listed first');
  }
  const list = listBackups(backupDir);
  assert.equal(list.length, 3);
  assert.ok(fs.existsSync(path.join(backupDir, 'keep-me.txt')), 'other files untouched');
  // The newest backup is a working database.
  const copy = new DatabaseSync(list[0].file, { readOnly: true });
  assert.equal(copy.prepare('SELECT MAX(version) AS v FROM schema_version').get().v, LATEST_VERSION);
  copy.close();
  db.close();
});
