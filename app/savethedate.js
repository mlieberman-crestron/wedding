// savethedate.js - the save-the-date card: validation, dates, the calendar
// (.ics) file and database access.
//
// One card per event, stored in the save_the_date table (migration 4).
// The pure functions (validation, date maths, .ics) take everything as
// arguments so they are easy to test; the data-access functions at the
// bottom take the database handle and the event id.

'use strict';

const { nowIso } = require('./db');

const FIELDS = ['headline', 'names', 'event_date', 'location', 'message'];

const FIELD_LABELS = {
  headline: 'Headline',
  names: 'Names',
  event_date: 'Wedding date',
  location: 'Place',
  message: 'Message',
};

const MAX_LENGTH = {
  headline: 60,
  names: 100,
  event_date: 10,
  location: 150,
  message: 1000,
};

const DEFAULT_HEADLINE = 'Save the Date';

// ---------------------------------------------------------------------------
// Dates. A wedding date is a calendar day (YYYY-MM-DD) with no time of day
// and no time zone, so all maths is done on UTC midnights.
// ---------------------------------------------------------------------------

// true for a real calendar date such as 2027-06-12 (not 2027-02-30).
function isValidDate(value) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value || ''));
  if (!m) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  if (y < 2000 || y > 2100) return false;
  const t = new Date(Date.UTC(y, mo - 1, d));
  return t.getUTCFullYear() === y && t.getUTCMonth() === mo - 1 && t.getUTCDate() === d;
}

const toUtc = (ymd) => {
  const [y, m, d] = ymd.split('-').map(Number);
  return Date.UTC(y, m - 1, d);
};
const fromUtc = (ms) => new Date(ms).toISOString().slice(0, 10);

// "Saturday, June 12, 2027"
function formatLongDate(ymd) {
  return new Date(toUtc(ymd)).toLocaleDateString('en-US', {
    timeZone: 'UTC', weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
  });
}

// Today's date (YYYY-MM-DD) in the given IANA time zone, e.g. America/New_York.
// An unknown zone falls back to UTC rather than crashing the page.
function todayIn(timeZone, now = new Date()) {
  try {
    // en-CA formats as YYYY-MM-DD.
    return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
  } catch {
    return now.toISOString().slice(0, 10);
  }
}

// Whole days from today to the wedding (negative once it has passed).
function daysUntil(eventDate, today) {
  return Math.round((toUtc(eventDate) - toUtc(today)) / 86400000);
}

function countdownText(eventDate, today) {
  if (!isValidDate(eventDate) || !isValidDate(today)) return '';
  const n = daysUntil(eventDate, today);
  if (n > 1) return `${n} days to go`;
  if (n === 1) return 'Tomorrow!';
  if (n === 0) return 'Today!';
  return ''; // after the wedding: say nothing
}

// ---------------------------------------------------------------------------
// Validation. input = raw form values. Returns { std, errors } where std is
// the cleaned card and errors maps field -> message.
// ---------------------------------------------------------------------------
function validateCard(input) {
  const std = {};
  const errors = {};
  for (const f of FIELDS) {
    // Normalise line endings; trim outer whitespace.
    std[f] = String(input[f] === undefined || input[f] === null ? '' : input[f]).replace(/\r\n?/g, '\n').trim();
    if (f !== 'message') std[f] = std[f].replace(/\s+/g, ' ');
    if (std[f].length > MAX_LENGTH[f]) errors[f] = `At most ${MAX_LENGTH[f]} characters.`;
  }
  std.published = input.published === true || input.published === '1' || input.published === 1 ? 1 : 0;
  if (!std.headline) std.headline = DEFAULT_HEADLINE;

  if (std.event_date && !isValidDate(std.event_date)) errors.event_date = 'Enter a real date (YYYY-MM-DD).';
  if (std.published) {
    if (!std.names) errors.names = 'Needed before the page can be published.';
    if (!std.event_date && !errors.event_date) errors.event_date = 'Needed before the page can be published.';
  }
  return { std, errors };
}

// The message as paragraphs (split on blank lines), each a list of lines.
function messageParagraphs(message) {
  return String(message || '')
    .split(/\n\s*\n/)
    .map((p) => p.split('\n').map((l) => l.trim()).filter(Boolean))
    .filter((lines) => lines.length);
}

// ---------------------------------------------------------------------------
// Calendar file (RFC 5545). An all-day event: DTEND is the day AFTER.
// ---------------------------------------------------------------------------

// Escape a TEXT value: backslash, semicolon, comma, newline.
function icsText(value) {
  return String(value || '')
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\r?\n/g, '\\n');
}

// Lines longer than 75 bytes are folded: CRLF + one space. Never split a
// multi-byte UTF-8 character.
function foldLine(line) {
  const out = [];
  let current = '';
  let bytes = 0;
  for (const ch of line) {
    const size = Buffer.byteLength(ch);
    const limit = out.length ? 74 : 75; // continuation lines start with a space
    if (bytes + size > limit) {
      out.push(current);
      current = '';
      bytes = 0;
    }
    current += ch;
    bytes += size;
  }
  out.push(current);
  return out.join('\r\n ');
}

const compactDate = (ymd) => ymd.replace(/-/g, '');
const icsStamp = (d) => d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, ''); // 20261116T140300Z

function buildIcs(std, { eventId, url, now = new Date() } = {}) {
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Wedding Platform//Save the Date//EN',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    'BEGIN:VEVENT',
    `UID:save-the-date-${Number(eventId) || 0}@wedding-platform`,
    `DTSTAMP:${icsStamp(now)}`,
    `DTSTART;VALUE=DATE:${compactDate(std.event_date)}`,
    `DTEND;VALUE=DATE:${compactDate(fromUtc(toUtc(std.event_date) + 86400000))}`,
    `SUMMARY:${icsText(std.names ? `${std.names} – wedding` : std.headline)}`,
  ];
  if (std.location) lines.push(`LOCATION:${icsText(std.location)}`);
  const details = [std.message, url].filter(Boolean).join('\n\n');
  if (details) lines.push(`DESCRIPTION:${icsText(details)}`);
  if (url) lines.push(`URL:${url}`);
  lines.push('TRANSP:TRANSPARENT', 'END:VEVENT', 'END:VCALENDAR');
  return lines.map(foldLine).join('\r\n') + '\r\n';
}

// "Add to Google Calendar" link (opens Google's own event form).
function googleCalendarUrl(std, url) {
  const p = new URLSearchParams({
    action: 'TEMPLATE',
    text: std.names ? `${std.names} – wedding` : std.headline,
    dates: `${compactDate(std.event_date)}/${compactDate(fromUtc(toUtc(std.event_date) + 86400000))}`,
  });
  if (std.location) p.set('location', std.location);
  const details = [std.message, url].filter(Boolean).join('\n\n');
  if (details) p.set('details', details);
  return `https://calendar.google.com/calendar/render?${p}`;
}

// ---------------------------------------------------------------------------
// Database access
// ---------------------------------------------------------------------------

function getCard(db, eventId) {
  return db
    .prepare('SELECT headline, names, event_date, location, message, published, updated_at FROM save_the_date WHERE event_id = ?')
    .get(eventId);
}

// Insert or replace the card for this event. std comes from validateCard().
function saveCard(db, eventId, std) {
  db.prepare(
    `INSERT INTO save_the_date (event_id, headline, names, event_date, location, message, published, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(event_id) DO UPDATE SET
       headline = excluded.headline, names = excluded.names, event_date = excluded.event_date,
       location = excluded.location, message = excluded.message, published = excluded.published,
       updated_at = excluded.updated_at`
  ).run(eventId, std.headline, std.names, std.event_date, std.location, std.message, std.published, nowIso());
}

module.exports = {
  FIELDS, FIELD_LABELS, MAX_LENGTH, DEFAULT_HEADLINE,
  isValidDate, formatLongDate, todayIn, daysUntil, countdownText,
  validateCard, messageParagraphs,
  icsText, foldLine, buildIcs, googleCalendarUrl,
  getCard, saveCard,
};
