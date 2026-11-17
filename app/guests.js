// guests.js - guest validation, CSV import rules and database access.
//
// The validation and import functions are "pure" (no database, no globals):
// they get everything they need as arguments, which makes them easy to test.
// The data-access functions at the bottom take the database handle and the
// event id, because every guest belongs to one event (one wedding).

'use strict';

const { parseCsv, unprotectCell } = require('./csv');
const { transaction, nowIso } = require('./db');

// Fields a guest has, in display/export order.
const FIELDS = ['first_name', 'last_name', 'household', 'email', 'phone', 'side', 'notes'];

const FIELD_LABELS = {
  first_name: 'First name',
  last_name: 'Last name',
  household: 'Household',
  email: 'Email',
  phone: 'Phone',
  side: 'Side',
  notes: 'Notes',
};

// Maximum lengths (characters).
const MAX_LENGTH = {
  first_name: 100,
  last_name: 100,
  household: 200,
  email: 254, // the longest valid email address
  phone: 50,
  notes: 2000,
};

const SIDES = ['', 'a', 'b', 'both'];

// Deliberately simple: something@something.something, no spaces.
// Real validation of an address is only possible by sending mail to it.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// ---------------------------------------------------------------------------
// Sides
// ---------------------------------------------------------------------------

// Text shown for a stored side value. labels = { a: 'Casey', b: 'Dustin' }
function sideLabel(side, labels) {
  if (side === 'a') return labels.a;
  if (side === 'b') return labels.b;
  if (side === 'both') return 'Both';
  return '';
}

// Turn what someone typed in a spreadsheet into a stored side value.
// Accepts a / b / both and the two configured labels, all case-insensitive.
// Anything else (including "bride"/"groom", unless a label is literally that)
// becomes '' and `unknown` is true so the caller can warn.
function parseSide(value, labels) {
  const v = String(value || '').trim().toLowerCase();
  if (v === '') return { side: '', unknown: false };
  if (v === 'a' || v === labels.a.toLowerCase()) return { side: 'a', unknown: false };
  if (v === 'b' || v === labels.b.toLowerCase()) return { side: 'b', unknown: false };
  if (v === 'both') return { side: 'both', unknown: false };
  return { side: '', unknown: true };
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

// Check one guest. `input` has the FIELDS as strings (side already a stored
// value: '', 'a', 'b' or 'both').
// Returns { guest, errors, warnings }:
//   guest    - cleaned values (trimmed)
//   errors   - { field: message }; any error means the guest must not be saved
//   warnings - [message]; the guest can be saved
// mode 'form'  : an invalid email is an error (the person can fix it).
// mode 'import': an invalid email is a warning; the guest is imported without
//                an email and the original text is kept at the end of notes,
//                so nothing that was in the file is lost.
function validateGuest(input, mode = 'form') {
  const guest = {};
  for (const f of FIELDS) guest[f] = String(input[f] === undefined || input[f] === null ? '' : input[f]).trim();
  const errors = {};
  const warnings = [];

  if (guest.first_name === '' && guest.last_name === '') {
    errors.first_name = 'Enter a first name or a last name.';
  }
  if (!SIDES.includes(guest.side)) {
    errors.side = 'Choose one of the listed sides.';
  }
  if (guest.email !== '' && !EMAIL_RE.test(guest.email)) {
    if (mode === 'import') {
      warnings.push(`Invalid email "${guest.email}" not imported (kept in notes).`);
      guest.notes = (guest.notes ? guest.notes + '\n' : '') + `Invalid email from import: ${guest.email}`;
      guest.email = '';
    } else {
      errors.email = 'This does not look like an email address (name@example.com).';
    }
  }
  for (const [field, max] of Object.entries(MAX_LENGTH)) {
    if (guest[field].length > max && !errors[field]) {
      errors[field] = `${FIELD_LABELS[field]} is too long (${guest[field].length} characters, max ${max}).`;
    }
  }
  return { guest, errors, warnings };
}

// Key used to spot duplicates: same first + last name (ignoring case) and the
// same email (ignoring case), where "both emails empty" also counts as same.
function duplicateKey(guest) {
  return [guest.first_name, guest.last_name, guest.email].map((s) => String(s || '').trim().toLowerCase()).join('\u0001');
}

// "Mary Ann Smith" -> first "Mary Ann", last "Smith"; "Cher" -> first "Cher".
function splitFullName(name) {
  const s = String(name || '').trim().replace(/\s+/g, ' ');
  const i = s.lastIndexOf(' ');
  return i === -1 ? { first_name: s, last_name: '' } : { first_name: s.slice(0, i), last_name: s.slice(i + 1) };
}

// ---------------------------------------------------------------------------
// CSV header matching
// ---------------------------------------------------------------------------

// Headers are compared after lower-casing and removing everything that is not
// a letter or digit, so "First Name", "first_name" and "FIRST-NAME" all
// become "firstname".
function normalizeHeader(h) {
  return String(h || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

// normalized header -> field. 'name' is a single full-name column.
const HEADER_ALIASES = {
  firstname: 'first_name', first: 'first_name', givenname: 'first_name', forename: 'first_name',
  lastname: 'last_name', last: 'last_name', surname: 'last_name', familyname: 'last_name',
  name: 'name', fullname: 'name', guest: 'name', guestname: 'name',
  household: 'household', family: 'household', party: 'household', group: 'household',
  email: 'email', emailaddress: 'email', mail: 'email',
  phone: 'phone', mobile: 'phone', cell: 'phone', phonenumber: 'phone',
  mobilephone: 'phone', cellphone: 'phone', telephone: 'phone', tel: 'phone',
  side: 'side', guestof: 'side', brideorgroom: 'side',
  notes: 'notes', note: 'notes', comments: 'notes', comment: 'notes',
};

// Map a header row to fields. Returns
//   { columns: [{ index, header, field }], ignored: [header], hasName }
// If two columns map to the same field, the first one wins and the other is
// listed as ignored.
function mapHeaders(headerFields) {
  const columns = [];
  const ignored = [];
  const taken = new Set();
  headerFields.forEach((header, index) => {
    const field = HEADER_ALIASES[normalizeHeader(header)];
    if (!field) {
      if (String(header).trim() !== '') ignored.push(String(header).trim());
    } else if (taken.has(field)) {
      ignored.push(`${String(header).trim()} (duplicate column)`);
    } else {
      taken.add(field);
      columns.push({ index, header: String(header).trim(), field });
    }
  });
  const hasName = taken.has('first_name') || taken.has('last_name') || taken.has('name');
  return { columns, ignored, hasName };
}

// ---------------------------------------------------------------------------
// Import planning (used by both the preview and the commit step)
// ---------------------------------------------------------------------------

// Work out what importing `text` would do, without writing anything.
//   existingGuests: guests already in the event (for duplicate detection)
//   labels: { a, b } side labels
//   options.maxRows, options.includeDuplicates
// Returns { error } if the file cannot be used at all, otherwise
//   { delimiter, columns, ignored, rows, counts, toImport, unterminatedQuote }
// Each row: { line, status, guest, messages } with status
//   'ok'        - will be imported
//   'warning'   - will be imported, but something was changed (see messages)
//   'error'     - skipped (e.g. no name)
//   'duplicate' - skipped unless includeDuplicates is set
function planImport(text, existingGuests, labels, options = {}) {
  const maxRows = options.maxRows || 5000;
  const includeDuplicates = Boolean(options.includeDuplicates);

  const parsed = parseCsv(String(text || ''));
  if (parsed.records.length === 0) return { error: 'There is nothing to import: the text is empty.' };

  const header = mapHeaders(parsed.records[0].fields);
  if (!header.hasName) {
    return {
      error:
        'No name column found in the first line. The first line must be a header with ' +
        'a "First name" and/or "Last name" column, or a single "Name" column.',
    };
  }
  const dataRecords = parsed.records.slice(1);
  if (dataRecords.length === 0) return { error: 'The file has a header line but no guest rows.' };
  if (dataRecords.length > maxRows) {
    return {
      error: `The file has ${dataRecords.length} guest rows; the limit is ${maxRows} per import. Split it into smaller files.`,
    };
  }

  const seen = new Set(existingGuests.map(duplicateKey));
  const rows = [];
  for (const record of dataRecords) {
    const raw = {};
    for (const col of header.columns) raw[col.field] = unprotectCell(String(record.fields[col.index] || '').trim());

    // A single "name" column is used when first and last name are both empty.
    if (raw.name !== undefined && !raw.first_name && !raw.last_name) Object.assign(raw, splitFullName(raw.name));

    const messages = [];
    const side = parseSide(raw.side, labels);
    if (side.unknown) messages.push(`Unknown side "${raw.side}" left empty (use ${labels.a}, ${labels.b} or Both).`);
    raw.side = side.side;

    const { guest, errors, warnings } = validateGuest(raw, 'import');
    messages.push(...warnings);

    let status;
    if (Object.keys(errors).length > 0) {
      status = 'error';
      messages.unshift(...Object.values(errors));
    } else if (seen.has(duplicateKey(guest))) {
      status = 'duplicate';
      messages.unshift('Same name and email as an existing guest or an earlier row.');
    } else {
      status = messages.length > 0 ? 'warning' : 'ok';
      seen.add(duplicateKey(guest)); // later identical rows count as duplicates
    }
    rows.push({ line: record.line, status, guest, messages });
  }

  const counts = { total: rows.length, ok: 0, warning: 0, error: 0, duplicate: 0 };
  for (const r of rows) counts[r.status]++;
  const toImport = rows
    .filter((r) => r.status === 'ok' || r.status === 'warning' || (includeDuplicates && r.status === 'duplicate'))
    .map((r) => r.guest);

  return {
    delimiter: parsed.delimiter,
    columns: header.columns,
    ignored: header.ignored,
    unterminatedQuote: parsed.unterminatedQuote,
    rows,
    counts,
    toImport,
  };
}

// ---------------------------------------------------------------------------
// Database access. eventId: the event (wedding) this container serves.
// ---------------------------------------------------------------------------

const COLUMNS = 'id, event_id, first_name, last_name, household, email, phone, side, notes, created_at, updated_at';
const ORDER = 'ORDER BY last_name COLLATE NOCASE, first_name COLLATE NOCASE, id';

// Guests of the event, optionally filtered by a search text that is matched
// (case-insensitively) against first/last name, household and email.
function listGuests(db, eventId, search = '') {
  const q = String(search).trim();
  if (q === '') return db.prepare(`SELECT ${COLUMNS} FROM guests WHERE event_id = ? ${ORDER}`).all(eventId);
  // Escape LIKE wildcards so a search for "50%" means the literal text.
  const pattern = '%' + q.replace(/[\\%_]/g, (c) => '\\' + c) + '%';
  // ?1 = event id, ?2 = pattern (numbered parameters can be used repeatedly).
  return db
    .prepare(
      `SELECT ${COLUMNS} FROM guests WHERE event_id = ?1
         AND (first_name LIKE ?2 ESCAPE '\\' OR last_name LIKE ?2 ESCAPE '\\'
              OR household LIKE ?2 ESCAPE '\\' OR email LIKE ?2 ESCAPE '\\'
              OR (first_name || ' ' || last_name) LIKE ?2 ESCAPE '\\')
       ${ORDER}`
    )
    .all(eventId, pattern);
}

// { total, a, b, both, none }
function countBySide(db, eventId) {
  const counts = { total: 0, a: 0, b: 0, both: 0, none: 0 };
  for (const row of db.prepare('SELECT side, COUNT(*) AS n FROM guests WHERE event_id = ? GROUP BY side').all(eventId)) {
    counts[row.side === '' ? 'none' : row.side] = row.n;
    counts.total += row.n;
  }
  return counts;
}

function getGuest(db, eventId, id) {
  return db.prepare(`SELECT ${COLUMNS} FROM guests WHERE event_id = ? AND id = ?`).get(eventId, id);
}

function insertGuest(db, eventId, g) {
  const now = nowIso();
  const result = db
    .prepare(
      `INSERT INTO guests (event_id, first_name, last_name, household, email, phone, side, notes, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(eventId, g.first_name, g.last_name, g.household, g.email, g.phone, g.side, g.notes, now, now);
  return Number(result.lastInsertRowid);
}

function updateGuest(db, eventId, id, g) {
  const result = db
    .prepare(
      `UPDATE guests SET first_name = ?, last_name = ?, household = ?, email = ?, phone = ?, side = ?, notes = ?,
         updated_at = ? WHERE event_id = ? AND id = ?`
    )
    .run(g.first_name, g.last_name, g.household, g.email, g.phone, g.side, g.notes, nowIso(), eventId, id);
  return result.changes === 1;
}

function deleteGuest(db, eventId, id) {
  return db.prepare('DELETE FROM guests WHERE event_id = ? AND id = ?').run(eventId, id).changes === 1;
}

// Insert many guests in ONE transaction: all of them or none.
function importGuests(db, eventId, guests) {
  return transaction(db, () => {
    for (const g of guests) insertGuest(db, eventId, g);
    return guests.length;
  });
}

module.exports = {
  FIELDS, FIELD_LABELS, MAX_LENGTH, SIDES,
  sideLabel, parseSide, validateGuest, duplicateKey, splitFullName,
  normalizeHeader, mapHeaders, HEADER_ALIASES, planImport,
  listGuests, countBySide, getGuest, insertGuest, updateGuest, deleteGuest, importGuests,
};
