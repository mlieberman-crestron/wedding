// Tests for the pure functions in app/guests.js (no database needed).
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const g = require('../app/guests');

const LABELS = { a: 'Casey', b: 'Dustin' };
const blank = { first_name: '', last_name: '', household: '', email: '', phone: '', side: '', notes: '' };

test('header aliases map to fields regardless of case, spaces and punctuation', () => {
  const cases = {
    'First Name': 'first_name', first: 'first_name', FIRSTNAME: 'first_name', 'Given name': 'first_name', first_name: 'first_name',
    'Last Name': 'last_name', last: 'last_name', Surname: 'last_name', 'family-name': 'last_name',
    Name: 'name', 'Full Name': 'name', Guest: 'name',
    Household: 'household', Family: 'household', Party: 'household', Group: 'household',
    Email: 'email', 'E-mail': 'email', 'Email Address': 'email',
    Phone: 'phone', Mobile: 'phone', Cell: 'phone', 'Phone Number': 'phone',
    Side: 'side', 'Guest of': 'side', 'Bride or Groom': 'side',
    Notes: 'notes', Comments: 'notes',
  };
  for (const [header, field] of Object.entries(cases)) {
    const m = g.mapHeaders([header]);
    assert.equal(m.columns[0] && m.columns[0].field, field, header);
  }
});

test('unknown and duplicate columns are listed as ignored', () => {
  const m = g.mapHeaders(['First', 'Table', 'Last', 'Mobile', 'Phone', '']);
  assert.deepEqual(m.columns.map((c) => c.field), ['first_name', 'last_name', 'phone']);
  assert.deepEqual(m.ignored, ['Table', 'Phone (duplicate column)']);
  assert.equal(m.hasName, true);
  assert.equal(g.mapHeaders(['Email', 'Phone']).hasName, false);
});

test('side parsing: a/b/both, labels case-insensitive, unknown -> empty', () => {
  assert.deepEqual(g.parseSide('casey', LABELS), { side: 'a', unknown: false });
  assert.deepEqual(g.parseSide(' DUSTIN ', LABELS), { side: 'b', unknown: false });
  assert.deepEqual(g.parseSide('A', LABELS), { side: 'a', unknown: false });
  assert.deepEqual(g.parseSide('b', LABELS), { side: 'b', unknown: false });
  assert.deepEqual(g.parseSide('Both', LABELS), { side: 'both', unknown: false });
  assert.deepEqual(g.parseSide('', LABELS), { side: '', unknown: false });
  assert.deepEqual(g.parseSide('bride', LABELS), { side: '', unknown: true });
  assert.deepEqual(g.parseSide('groom', LABELS), { side: '', unknown: true });
  // ...unless a label really is "Bride"
  assert.deepEqual(g.parseSide('bride', { a: 'Bride', b: 'Groom' }), { side: 'a', unknown: false });
  assert.equal(g.sideLabel('a', LABELS), 'Casey');
  assert.equal(g.sideLabel('both', LABELS), 'Both');
  assert.equal(g.sideLabel('', LABELS), '');
});

test('validation: a name is required', () => {
  const r = g.validateGuest({ ...blank, email: 'x@example.com' });
  assert.ok(r.errors.first_name);
  assert.deepEqual(g.validateGuest({ ...blank, last_name: 'Only' }).errors, {});
  assert.deepEqual(g.validateGuest({ ...blank, first_name: 'Only' }).errors, {});
});

test('validation: values are trimmed, phone kept as typed', () => {
  const r = g.validateGuest({ ...blank, first_name: '  Ann ', phone: ' (555) 01-02 ' });
  assert.equal(r.guest.first_name, 'Ann');
  assert.equal(r.guest.phone, '(555) 01-02');
});

test('validation: email format, form vs import', () => {
  const bad = { ...blank, first_name: 'A', email: 'not-an-email', notes: 'hello' };
  const form = g.validateGuest(bad, 'form');
  assert.ok(form.errors.email, 'form: error');
  const imp = g.validateGuest(bad, 'import');
  assert.deepEqual(imp.errors, {}, 'import: no error');
  assert.equal(imp.guest.email, '', 'import: email removed');
  assert.match(imp.guest.notes, /^hello\nInvalid email from import: not-an-email$/);
  assert.equal(imp.warnings.length, 1);
  assert.deepEqual(g.validateGuest({ ...blank, first_name: 'A', email: 'a.b@example.co.uk' }).errors, {});
});

test('validation: side must be an allowed value; length limits', () => {
  assert.ok(g.validateGuest({ ...blank, first_name: 'A', side: 'bride' }).errors.side);
  assert.ok(g.validateGuest({ ...blank, first_name: 'x'.repeat(101) }).errors.first_name);
  assert.ok(g.validateGuest({ ...blank, first_name: 'A', notes: 'x'.repeat(2001) }).errors.notes);
  assert.deepEqual(g.validateGuest({ ...blank, first_name: 'x'.repeat(100) }).errors, {});
});

test('full name splitting on the last space', () => {
  assert.deepEqual(g.splitFullName('Mary Ann  Smith'), { first_name: 'Mary Ann', last_name: 'Smith' });
  assert.deepEqual(g.splitFullName('Cher'), { first_name: 'Cher', last_name: '' });
});

test('duplicate key: name and email case-insensitive, empty emails match', () => {
  const k = g.duplicateKey;
  assert.equal(k({ first_name: 'Ann', last_name: 'Lee', email: 'A@X.COM' }), k({ first_name: 'ann', last_name: 'LEE', email: 'a@x.com' }));
  assert.equal(k({ first_name: 'Ann', last_name: 'Lee', email: '' }), k({ first_name: 'ann', last_name: 'lee', email: '' }));
  assert.notEqual(k({ first_name: 'Ann', last_name: 'Lee', email: '' }), k({ first_name: 'Ann', last_name: 'Lee', email: 'a@x.com' }));
});

test('import plan: duplicates against existing guests and earlier rows', () => {
  const existing = [{ ...blank, first_name: 'Ann', last_name: 'Lee', email: 'ann@example.com' }];
  const csv = 'First,Last,Email\nANN,lee,Ann@Example.com\nBo,Diddley,\nbo,diddley,\nBo,Diddley,bo@example.com\n';
  const plan = g.planImport(csv, existing, LABELS);
  assert.deepEqual(plan.rows.map((r) => r.status), ['duplicate', 'ok', 'duplicate', 'ok']);
  assert.equal(plan.toImport.length, 2);
  const withDups = g.planImport(csv, existing, LABELS, { includeDuplicates: true });
  assert.equal(withDups.toImport.length, 4);
});

test('import plan: single name column, unknown side warning, errors', () => {
  const plan = g.planImport('Full Name;Bride or Groom\nMary Ann Smith;groom\n;Casey\nCher;b\n', [], LABELS);
  assert.equal(plan.delimiter, ';');
  const [r1, r2, r3] = plan.rows;
  assert.equal(r1.status, 'warning');
  assert.deepEqual([r1.guest.first_name, r1.guest.last_name, r1.guest.side], ['Mary Ann', 'Smith', '']);
  assert.equal(r2.status, 'error');
  assert.equal(r3.status, 'ok');
  assert.equal(r3.guest.side, 'b');
});

test('import plan: file-level errors', () => {
  assert.match(g.planImport('', [], LABELS).error, /empty/);
  assert.match(g.planImport('Email,Phone\na@b.c,1\n', [], LABELS).error, /No name column/);
  assert.match(g.planImport('First\n', [], LABELS).error, /no guest rows/);
  const big = 'First\n' + 'x\n'.repeat(11);
  assert.match(g.planImport(big, [], LABELS, { maxRows: 10 }).error, /11 guest rows; the limit is 10/);
});

test('import plan: sample-guests.csv gives the documented counts', () => {
  const text = fs.readFileSync(path.join(__dirname, '..', 'sample-guests.csv'), 'utf8');
  const plan = g.planImport(text, [], LABELS);
  assert.deepEqual(plan.counts, { total: 13, ok: 9, warning: 2, error: 1, duplicate: 1 });
  assert.equal(plan.toImport.length, 11);
  assert.deepEqual(plan.ignored, ['Table']);
  const penny = plan.rows[0].guest;
  assert.equal(penny.household, 'Farthing, Penny & Bob');
  const anita = plan.rows.find((r) => r.guest.first_name === 'Anita').guest;
  assert.equal(anita.notes, 'Two-line note: first line\nsecond line');

  // Importing the same file again (now everything exists): all duplicates
  // except the nameless row, which is still an error.
  const again = g.planImport(text, plan.toImport, LABELS);
  assert.deepEqual(again.counts, { total: 13, ok: 0, warning: 0, error: 1, duplicate: 12 });
});
