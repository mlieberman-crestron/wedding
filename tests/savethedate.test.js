// Tests for app/savethedate.js and the save-the-date page HTML.
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { openDatabase, migrate } = require('../app/db');
const s = require('../app/savethedate');
const views = require('../app/views');

const card = (over = {}) => ({
  headline: 'Save the Date',
  names: 'Casey & Dustin',
  event_date: '2027-06-12',
  location: 'Asheville, North Carolina',
  message: 'Formal invitation to follow.',
  published: 1,
  ...over,
});

test('dates: real calendar days only', () => {
  assert.ok(s.isValidDate('2027-06-12'));
  assert.ok(s.isValidDate('2028-02-29'), 'leap day');
  for (const bad of ['2027-02-29', '2027-13-01', '2027-6-12', '12/06/2027', '', null, '1999-01-01']) {
    assert.equal(s.isValidDate(bad), false, String(bad));
  }
  assert.equal(s.formatLongDate('2027-06-12'), 'Saturday, June 12, 2027');
});

test('countdown counts whole days and goes quiet afterwards', () => {
  assert.equal(s.countdownText('2027-06-12', '2027-06-01'), '11 days to go');
  assert.equal(s.countdownText('2027-06-12', '2027-06-11'), 'Tomorrow!');
  assert.equal(s.countdownText('2027-06-12', '2027-06-12'), 'Today!');
  assert.equal(s.countdownText('2027-06-12', '2027-06-13'), '');
  // Across a daylight-saving change (dates are UTC midnights, no drift).
  assert.equal(s.daysUntil('2027-03-15', '2027-03-13'), 2);
});

test('today follows the configured time zone', () => {
  const lateEvening = new Date('2026-11-17T03:00:00Z'); // 10 pm on the 16th in New York
  assert.equal(s.todayIn('America/New_York', lateEvening), '2026-11-16');
  assert.equal(s.todayIn('UTC', lateEvening), '2026-11-17');
  assert.equal(s.todayIn('Not/AZone', lateEvening), '2026-11-17', 'unknown zone falls back to UTC');
});

test('validation: trims, defaults the headline, requires names and date to publish', () => {
  let r = s.validateCard({ headline: '  ', names: ' Casey   &  Dustin ', event_date: '', location: '', message: ' a\r\nb ', published: '0' });
  assert.deepEqual(r.errors, {});
  assert.equal(r.std.headline, 'Save the Date');
  assert.equal(r.std.names, 'Casey & Dustin');
  assert.equal(r.std.message, 'a\nb');
  assert.equal(r.std.published, 0);

  r = s.validateCard({ names: '', event_date: '', published: '1' });
  assert.ok(r.errors.names);
  assert.ok(r.errors.event_date);

  r = s.validateCard({ names: 'A', event_date: '2027-02-30', published: '1' });
  assert.match(r.errors.event_date, /real date/);

  r = s.validateCard({ names: 'x'.repeat(101), event_date: '2027-06-12' });
  assert.match(r.errors.names, /100/);
});

test('message paragraphs split on blank lines', () => {
  assert.deepEqual(s.messageParagraphs('One\nTwo\n\n\nThree\n  \n'), [['One', 'Two'], ['Three']]);
  assert.deepEqual(s.messageParagraphs(''), []);
});

test('calendar file: all-day event, escaped text, CRLF, folded lines', () => {
  const ics = s.buildIcs(card({ location: 'Hall; Room 1, Floor 2', message: 'Line one\nLine two' }), {
    eventId: 1,
    url: 'https://example.test/save-the-date',
    now: new Date('2026-11-16T14:03:00.123Z'),
  });
  assert.ok(ics.endsWith('\r\n'));
  assert.ok(!/[^\r]\n/.test(ics), 'every line break is CRLF');
  const unfolded = ics.replace(/\r\n /g, '');
  assert.match(unfolded, /DTSTART;VALUE=DATE:20270612\r\n/);
  assert.match(unfolded, /DTEND;VALUE=DATE:20270613\r\n/);
  assert.match(unfolded, /DTSTAMP:20261116T140300Z\r\n/);
  assert.match(unfolded, /LOCATION:Hall\\; Room 1\\, Floor 2\r\n/);
  assert.match(unfolded, /DESCRIPTION:Line one\\nLine two\\n\\nhttps:\/\/example.test\/save-the-date\r\n/);
  for (const line of ics.split('\r\n')) assert.ok(Buffer.byteLength(line) <= 75, `line too long: ${line}`);
});

test('calendar file: year end rolls over; folding never splits a character', () => {
  const ics = s.buildIcs(card({ event_date: '2027-12-31' }), { eventId: 1 });
  assert.match(ics, /DTEND;VALUE=DATE:20280101\r\n/);
  const folded = s.foldLine('DESCRIPTION:' + 'é'.repeat(80));
  for (const part of folded.split('\r\n')) assert.ok(Buffer.byteLength(part) <= 75);
  assert.equal(folded.replace(/\r\n /g, ''), 'DESCRIPTION:' + 'é'.repeat(80));
});

test('Google Calendar link carries the dates and place', () => {
  const u = new URL(s.googleCalendarUrl(card(), ''));
  assert.equal(u.hostname, 'calendar.google.com');
  assert.equal(u.searchParams.get('dates'), '20270612/20270613');
  assert.equal(u.searchParams.get('location'), 'Asheville, North Carolina');
});

test('page HTML escapes everything and adds the calendar links only with a date', () => {
  const html = views.saveTheDatePage({
    card: card({ names: '<script>alert(1)</script>', message: 'Hi <b>there</b>\n\nBye' }),
    today: '2027-06-01',
    publicUrl: '',
  });
  assert.ok(!html.includes('<script>alert(1)'), 'names escaped');
  assert.ok(html.includes('&lt;script&gt;'));
  assert.ok(html.includes('Hi &lt;b&gt;there&lt;/b&gt;'));
  assert.ok(html.includes('<p>Bye</p>'));
  assert.ok(html.includes('11 days to go'));
  assert.ok(html.includes('href="/save-the-date.ics"'));
  assert.ok(html.includes('noindex'));

  const noDate = views.saveTheDatePage({ card: card({ event_date: '' }), today: '2027-06-01', publicUrl: '' });
  assert.ok(noDate.includes('Date to be announced'));
  assert.ok(!noDate.includes('.ics'));
});

test('migration 4 seeds an unpublished card from the event name; save replaces it', () => {
  const db = openDatabase(path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'wedding-test-')), 'app.db'));
  migrate(db, { eventName: 'Casey & Dustin' });
  const eventId = db.prepare('SELECT id FROM events').get().id;

  let row = s.getCard(db, eventId);
  assert.equal(row.names, 'Casey & Dustin');
  assert.equal(row.published, 0);
  assert.equal(row.headline, 'Save the Date');

  const { std } = s.validateCard(card());
  s.saveCard(db, eventId, std);
  row = s.getCard(db, eventId);
  assert.equal(row.event_date, '2027-06-12');
  assert.equal(row.published, 1);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM save_the_date').get().n, 1);

  // The table itself refuses a malformed date.
  assert.throws(() => db.prepare("UPDATE save_the_date SET event_date = 'June 12'").run(), /CHECK/);
  db.close();
});
