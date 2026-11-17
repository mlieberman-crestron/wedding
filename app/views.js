// views.js - HTML for every page.
//
// Escaping rule: ANY value that did not come from this file (guest data,
// settings, search text, error messages containing user input) goes through
// h() before it is put into HTML. h() turns < > & " ' into entities, so a
// guest named <script>alert(1)</script> is shown as text, never run.
// Pages contain no inline scripts or styles (the Content-Security-Policy in
// web.js forbids them); styling is in /static/style.css.

'use strict';

const { FIELD_LABELS, MAX_LENGTH, sideLabel } = require('./guests');
const std = require('./savethedate');

function h(value) {
  return String(value === null || value === undefined ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// Hidden CSRF field for forms that change something (see auth.js).
const csrfField = (token) => `<input type="hidden" name="_csrf" value="${h(token)}">`;

// Page frame. opts.csrf present = logged in: show the admin menu.
function layout(title, body, opts = {}) {
  const nav = opts.csrf
    ? `<nav class="admin-nav">
    <a href="/admin">Admin</a>
    <a href="/admin/guests">Guests</a>
    <a href="/admin/guests/import">Import</a>
    <a href="/admin/guests/export.csv">Export CSV</a>
    <a href="/admin/save-the-date">Save the date</a>
    <form method="post" action="/admin/logout" class="inline">${csrfField(opts.csrf)}<button type="submit" class="link">Log out</button></form>
  </nav>`
    : '';
  // The status page has neither event name nor menu: then no header at all.
  const header =
    opts.eventName || nav ? `<header>\n  <div class="event">${h(opts.eventName || '')}</div>\n  ${nav}\n</header>\n` : '';
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${h(title)}${opts.eventName ? ' – ' + h(opts.eventName) : ''}</title>
  <link rel="stylesheet" href="/static/style.css">
${opts.head || ''}</head>
<body${opts.bodyClass ? ` class="${h(opts.bodyClass)}"` : ''}>
${header}<main>
${body}
</main>
${opts.scripts || ''}
</body>
</html>
`;
}

function notice(text, kind = 'ok') {
  return text ? `<p class="notice ${kind}" role="status">${h(text)}</p>` : '';
}

function formatBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

// --- Public pages ------------------------------------------------------------

// The 0.1.0 status page. The smoke tests read <span id="visits">N</span>.
function statusPage(info, visits) {
  const rows = [
    ['Version', info.version],
    ['APP_ENV', info.appEnv],
    ['EVENT_NAME', info.eventName],
    ['Hostname', info.hostname],
    ['Server started', info.startedAt],
  ]
    .map(([k, v]) => `    <tr><th>${h(k)}</th><td>${h(v)}</td></tr>`)
    .join('\n');
  return layout(
    info.appName,
    `<h1>${h(info.appName)}</h1>
  <table class="kv">
${rows}
    <tr><th>Visits</th><td><span id="visits">${Number(visits)}</span></td></tr>
  </table>
  <p><a href="/admin">Admin</a></p>`
  );
}

function messagePage(title, text, opts = {}) {
  return layout(title, `<h1>${h(title)}</h1>\n<p>${h(text)}</p>\n<p><a href="${h(opts.backHref || '/')}">Back</a></p>`, opts);
}

// --- Login -------------------------------------------------------------------

function loginPage({ enabled, placeholder, loginToken, error, lockedSeconds, eventName }) {
  if (!enabled) {
    return layout(
      'Admin login',
      `<h1>Admin login is disabled</h1>
<p>No admin password is set. To enable the admin pages, set the environment
variable <code>ADMIN_PASSWORD</code> to a real password (not empty and not
<code>${h(placeholder)}</code>):</p>
<ul>
  <li>Portainer: Stacks &rarr; wedding &rarr; Editor, change <code>ADMIN_PASSWORD</code>,
      then click <strong>Update the stack</strong>.</li>
  <li>docker compose: set <code>ADMIN_PASSWORD=...</code> in <code>.env</code> and run
      <code>sh scripts/deploy.sh</code>.</li>
</ul>
<p><a href="/">Back to the status page</a></p>`,
      { eventName }
    );
  }
  const lockedMsg = lockedSeconds
    ? notice(`Too many failed attempts. Try again in ${lockedSeconds} seconds.`, 'error')
    : '';
  return layout(
    'Admin login',
    `<h1>Admin login</h1>
${lockedMsg}${notice(error, 'error')}
<form method="post" action="/admin/login" class="stack narrow">
  <input type="hidden" name="_csrf" value="${h(loginToken)}">
  <label>Password <input type="password" name="password" autocomplete="current-password" required autofocus></label>
  <button type="submit">Log in</button>
</form>
<p><a href="/">Back to the status page</a></p>`,
    { eventName }
  );
}

// --- Admin home ----------------------------------------------------------------

function adminHomePage({ info, counts, backups, csrf, message, error }) {
  const backupRows = backups.length
    ? backups
        .map((b) => `<tr><td>${h(b.name)}</td><td class="num">${h(formatBytes(b.size))}</td><td>${h(b.mtime)}</td></tr>`)
        .join('\n')
    : '<tr><td colspan="3">No backups yet.</td></tr>';
  return layout(
    'Admin',
    `<h1>Admin</h1>
${notice(message)}${notice(error, 'error')}
<ul class="links">
  <li><a href="/admin/guests">Guest list</a> (${Number(counts.total)} guests)</li>
  <li><a href="/admin/guests/new">Add a guest</a></li>
  <li><a href="/admin/guests/import">Import guests from CSV</a></li>
  <li><a href="/admin/guests/export.csv">Export guests as CSV</a></li>
  <li><a href="/admin/save-the-date">Save-the-date page</a></li>
</ul>

<h2>Backups</h2>
<form method="post" action="/admin/backup">
  ${csrfField(csrf)}
  <button type="submit">Create backup now</button>
</form>
<p class="hint">Backups are written to <code>${h(info.backupDir)}</code>; the newest ${Number(info.backupsToKeep)} are kept. Times are UTC.</p>
<div class="table-wrap"><table>
  <thead><tr><th>File</th><th>Size</th><th>Time (UTC)</th></tr></thead>
  <tbody>
${backupRows}
  </tbody>
</table></div>

<h2>About</h2>
<table class="kv">
  <tr><th>Event</th><td>${h(info.eventName)}</td></tr>
  <tr><th>Version</th><td>${h(info.version)}</td></tr>
  <tr><th>APP_ENV</th><td>${h(info.appEnv)}</td></tr>
  <tr><th>Schema version</th><td>${h(info.schemaVersion)}</td></tr>
  <tr><th>Sides</th><td>${h(info.labels.a)} / ${h(info.labels.b)}</td></tr>
</table>`,
    { csrf, eventName: info.eventName }
  );
}

// --- Guest list ----------------------------------------------------------------

const NOTICES = {
  added: 'Guest added.',
  saved: 'Changes saved.',
  deleted: 'Guest deleted.',
};

function guestListPage({ guests, counts, search, labels, csrf, eventName, done, imported, skipped }) {
  let msg = NOTICES[done] || '';
  if (done === 'imported') msg = `Import finished: ${Number(imported)} guests added, ${Number(skipped)} rows skipped.`;

  const rows = guests.length
    ? guests
        .map(
          (g) => `<tr>
  <td>${h(g.last_name)}${g.last_name && g.first_name ? ', ' : ''}${h(g.first_name)}</td>
  <td>${h(g.household)}</td>
  <td>${h(g.email)}</td>
  <td>${h(g.phone)}</td>
  <td>${h(sideLabel(g.side, labels))}</td>
  <td class="actions"><a href="/admin/guests/${Number(g.id)}/edit">Edit</a> <a href="/admin/guests/${Number(g.id)}/delete">Delete</a></td>
</tr>`
        )
        .join('\n')
    : `<tr><td colspan="6">${search ? 'No guests match your search.' : 'No guests yet.'}</td></tr>`;

  const showing = search ? `<p>${guests.length} of ${Number(counts.total)} guests match &ldquo;${h(search)}&rdquo;. <a href="/admin/guests">Show all</a></p>` : '';

  return layout(
    'Guests',
    `<h1>Guests</h1>
${notice(msg)}
<p class="counts"><strong id="guest-count">${Number(counts.total)}</strong> guests:
  ${h(labels.a)} ${Number(counts.a)} &middot; ${h(labels.b)} ${Number(counts.b)} &middot;
  Both ${Number(counts.both)} &middot; Not set ${Number(counts.none)}</p>
<form method="get" action="/admin/guests" class="search">
  <input type="search" name="q" value="${h(search)}" placeholder="Search name, household, email" aria-label="Search">
  <button type="submit">Search</button>
</form>
<p><a class="button" href="/admin/guests/new">Add guest</a></p>
${showing}
<div class="table-wrap"><table>
  <thead><tr><th>Name</th><th>Household</th><th>Email</th><th>Phone</th><th>Side</th><th></th></tr></thead>
  <tbody>
${rows}
  </tbody>
</table></div>`,
    { csrf, eventName }
  );
}

// --- Add / edit form -------------------------------------------------------------

function guestFormPage({ mode, id, guest, errors = {}, labels, csrf, eventName }) {
  const isNew = mode === 'new';
  const action = isNew ? '/admin/guests/new' : `/admin/guests/${Number(id)}/edit`;
  const err = (f) => (errors[f] ? `<span class="field-error">${h(errors[f])}</span>` : '');
  const cls = (f) => (errors[f] ? ' class="has-error"' : '');
  const input = (f, type = 'text', extra = '') =>
    `<label${cls(f)}>${h(FIELD_LABELS[f])} <input type="${type}" name="${f}" value="${h(guest[f])}" maxlength="${MAX_LENGTH[f]}"${extra}>${err(f)}</label>`;
  const sideOptions = [
    ['', 'Not set'],
    ['a', labels.a],
    ['b', labels.b],
    ['both', 'Both'],
  ]
    .map(([v, text]) => `<option value="${h(v)}"${guest.side === v ? ' selected' : ''}>${h(text)}</option>`)
    .join('');

  return layout(
    isNew ? 'Add guest' : 'Edit guest',
    `<h1>${isNew ? 'Add guest' : 'Edit guest'}</h1>
${Object.keys(errors).length ? notice('Please correct the marked fields.', 'error') : ''}
<form method="post" action="${action}" class="stack">
  ${csrfField(csrf)}
  ${input('first_name', 'text', ' autocomplete="off"')}
  ${input('last_name', 'text', ' autocomplete="off"')}
  ${input('household')}
  ${input('email', 'email')}
  ${input('phone', 'tel')}
  <label${cls('side')}>Side <select name="side">${sideOptions}</select>${err('side')}</label>
  <label${cls('notes')}>Notes <textarea name="notes" rows="3" maxlength="${MAX_LENGTH.notes}">${h(guest.notes)}</textarea>${err('notes')}</label>
  <div class="buttons"><button type="submit">${isNew ? 'Add guest' : 'Save changes'}</button> <a href="/admin/guests">Cancel</a></div>
</form>`,
    { csrf, eventName }
  );
}

// Delete confirmation is a separate page with a POST form, so it works
// without JavaScript (no confirm() dialog).
function deleteConfirmPage({ guest, csrf, eventName }) {
  const name = [guest.first_name, guest.last_name].filter(Boolean).join(' ');
  return layout(
    'Delete guest',
    `<h1>Delete guest?</h1>
<p>Delete <strong>${h(name)}</strong>${guest.household ? ` (${h(guest.household)})` : ''}? This cannot be undone.</p>
<form method="post" action="/admin/guests/${Number(guest.id)}/delete" class="buttons">
  ${csrfField(csrf)}
  <button type="submit" class="danger">Delete</button> <a href="/admin/guests">Cancel</a>
</form>`,
    { csrf, eventName }
  );
}

// --- Import ------------------------------------------------------------------------

function importFormPage({ csv = '', error, csrf, eventName, maxRows, labels }) {
  return layout(
    'Import guests',
    `<h1>Import guests from CSV</h1>
${notice(error, 'error')}
<p>The first line must be a header. Recognised columns (any capitalisation):
first name, last name (or one <em>name</em> column), household, email, phone,
side (<em>${h(labels.a)}</em>, <em>${h(labels.b)}</em> or <em>Both</em>), notes.
Other columns are ignored. Up to ${Number(maxRows)} rows. Nothing is saved until
you confirm on the next page.</p>
<form method="post" action="/admin/guests/import" class="stack">
  ${csrfField(csrf)}
  <div id="file-picker" class="file-picker" hidden>
    <label>Choose a CSV file <input type="file" id="csv-file" accept=".csv,.txt,text/csv,text/plain"></label>
    <span id="file-status" class="hint" aria-live="polite"></span>
  </div>
  <label>CSV text (paste here, or choose a file above)
    <textarea id="csv" name="csv" rows="14" spellcheck="false" required>${h(csv)}</textarea></label>
  <div class="buttons"><button type="submit">Preview</button></div>
</form>`,
    { csrf, eventName, scripts: '<script src="/static/import.js"></script>' }
  );
}

const STATUS_TEXT = { ok: 'OK', warning: 'Warning', error: 'Error', duplicate: 'Duplicate' };
const DELIMITER_NAME = { ',': 'comma', ';': 'semicolon', '\t': 'tab' };

function importPreviewPage({ plan, csv, csrf, labels, eventName }) {
  const c = plan.counts;
  const rows = plan.rows
    .map(
      (r) => `<tr class="status-${r.status}">
  <td class="num">${Number(r.line)}</td>
  <td>${h(STATUS_TEXT[r.status])}</td>
  <td>${h(r.guest.first_name)}</td><td>${h(r.guest.last_name)}</td><td>${h(r.guest.household)}</td>
  <td>${h(r.guest.email)}</td><td>${h(r.guest.phone)}</td><td>${h(sideLabel(r.guest.side, labels))}</td>
  <td>${r.messages.map(h).join('<br>')}</td>
</tr>`
    )
    .join('\n');
  const willImport = c.ok + c.warning;
  const mapped = plan.columns.map((col) => `${h(col.header)} &rarr; ${h(col.field === 'name' ? 'full name' : FIELD_LABELS[col.field])}`).join(', ');

  return layout(
    'Import preview',
    `<h1>Import preview</h1>
<p>Nothing has been saved yet.</p>
${plan.unterminatedQuote ? notice('The text ends inside a quoted value: a closing " is probably missing. Check the last rows.', 'error') : ''}
<table class="kv">
  <tr><th>Rows read</th><td>${Number(c.total)}</td></tr>
  <tr><th>OK</th><td>${Number(c.ok)}</td></tr>
  <tr><th>Warnings (will be imported)</th><td>${Number(c.warning)}</td></tr>
  <tr><th>Errors (skipped)</th><td>${Number(c.error)}</td></tr>
  <tr><th>Duplicates (skipped)</th><td>${Number(c.duplicate)}</td></tr>
  <tr><th>Delimiter</th><td>${h(DELIMITER_NAME[plan.delimiter])}</td></tr>
  <tr><th>Columns used</th><td>${mapped}</td></tr>
  <tr><th>Columns ignored</th><td>${plan.ignored.length ? plan.ignored.map(h).join(', ') : 'none'}</td></tr>
</table>

<form method="post" action="/admin/guests/import/commit" class="stack">
  ${csrfField(csrf)}
  <!-- The CSV text travels back with the confirm button; the server parses
       and checks it again instead of trusting anything shown on this page. -->
  <textarea name="csv" hidden>${h(csv)}</textarea>
  ${c.duplicate ? `<label class="check"><input type="checkbox" name="include_duplicates" value="1"> Also import the ${Number(c.duplicate)} duplicate rows</label>` : ''}
  <div class="buttons">
    <button type="submit"${willImport + c.duplicate === 0 ? ' disabled' : ''}>Import ${Number(willImport)} guests</button>
    <a href="/admin/guests/import">Start over</a>
  </div>
</form>

<div class="table-wrap"><table class="preview">
  <thead><tr><th>Line</th><th>Status</th><th>First</th><th>Last</th><th>Household</th><th>Email</th><th>Phone</th><th>Side</th><th>Messages</th></tr></thead>
  <tbody>
${rows}
  </tbody>
</table></div>`,
    { csrf, eventName }
  );
}

// --- Save the date -------------------------------------------------------------------

// The card itself. card = row from savethedate.getCard(); today = YYYY-MM-DD.
// preview = true: shown to the admin, with a banner, whether published or not.
function saveTheDatePage({ card, today, publicUrl, preview = false }) {
  const hasDate = std.isValidDate(card.event_date);
  const countdown = hasDate ? std.countdownText(card.event_date, today) : '';
  const message = std
    .messageParagraphs(card.message)
    .map((lines) => `<p>${lines.map(h).join('<br>')}</p>`)
    .join('\n    ');
  const calendar = hasDate
    ? `<p class="std-cal">Add to your calendar:
    <a href="/save-the-date.ics">Apple / Outlook</a>
    <span aria-hidden="true">&middot;</span>
    <a href="${h(std.googleCalendarUrl(card, publicUrl))}" rel="noopener noreferrer" target="_blank">Google</a></p>`
    : '';
  const banner = preview
    ? `<div class="std-preview" role="status">Preview &mdash; ${card.published ? 'this page is published' : 'not published yet; guests see &ldquo;Not found&rdquo;'}.
  <a href="/admin/save-the-date">Back to editing</a></div>\n`
    : '';
  const title = card.names ? `${card.headline} – ${card.names}` : card.headline;
  const description = [hasDate ? std.formatLongDate(card.event_date) : '', card.location].filter(Boolean).join(' · ');

  return layout(
    title,
    `${banner}<article class="std-card">
  <p class="std-headline">${h(card.headline)}</p>
  <h1 class="std-names">${h(card.names)}</h1>
  <div class="std-rule" aria-hidden="true"><span></span></div>
  <p class="std-date">${hasDate ? `<time datetime="${h(card.event_date)}">${h(std.formatLongDate(card.event_date))}</time>` : 'Date to be announced'}</p>
  ${card.location ? `<p class="std-location">${h(card.location)}</p>` : ''}
  ${countdown ? `<p class="std-countdown">${h(countdown)}</p>` : ''}
  ${message ? `<div class="std-message">\n    ${message}\n  </div>` : ''}
  ${calendar}
</article>`,
    {
      bodyClass: 'std',
      // noindex: keep the wedding out of search engines.
      head:
        '  <meta name="robots" content="noindex, nofollow">\n' +
        `  <meta property="og:title" content="${h(title)}">\n` +
        (description ? `  <meta name="description" content="${h(description)}">\n  <meta property="og:description" content="${h(description)}">\n` : ''),
    }
  );
}

function saveTheDateFormPage({ card, errors = {}, csrf, eventName, done, publicUrl }) {
  const err = (f) => (errors[f] ? `<span class="field-error">${h(errors[f])}</span>` : '');
  const cls = (f) => (errors[f] ? ' class="has-error"' : '');
  const input = (f, type = 'text', extra = '') =>
    `<label${cls(f)}>${h(std.FIELD_LABELS[f])} <input type="${type}" name="${f}" value="${h(card[f])}" maxlength="${std.MAX_LENGTH[f]}"${extra}>${err(f)}</label>`;
  const where = publicUrl ? `${publicUrl}/save-the-date` : '/save-the-date';
  const status = card.published
    ? `<strong>Published.</strong> Guests can see it at <a href="/save-the-date">${h(where)}</a>.`
    : '<strong>Not published.</strong> Guests who open the page see &ldquo;Not found&rdquo;.';

  return layout(
    'Save the date',
    `<h1>Save-the-date page</h1>
${done === 'saved' ? notice('Saved.') : ''}${Object.keys(errors).length ? notice('Please correct the marked fields. Nothing was saved.', 'error') : ''}
<p>${status} <a href="/admin/save-the-date/preview">Preview</a></p>
<form method="post" action="/admin/save-the-date" class="stack">
  ${csrfField(csrf)}
  ${input('headline', 'text', ` placeholder="${h(std.DEFAULT_HEADLINE)}"`)}
  ${input('names', 'text', ' placeholder="Casey &amp; Dustin"')}
  ${input('event_date', 'date', ' placeholder="YYYY-MM-DD"')}
  ${input('location', 'text', ' placeholder="City, State (the venue can come with the invitation)"')}
  <label${cls('message')}>${h(std.FIELD_LABELS.message)}
    <textarea name="message" rows="4" maxlength="${std.MAX_LENGTH.message}" class="prose">${h(card.message)}</textarea>
    <span class="hint">A blank line starts a new paragraph.</span>${err('message')}</label>
  <label class="check"><input type="checkbox" name="published" value="1"${card.published ? ' checked' : ''}> Published (guests can see the page)</label>
  <div class="buttons"><button type="submit">Save</button> <a href="/admin/save-the-date/preview">Preview</a></div>
</form>`,
    { csrf, eventName }
  );
}

module.exports = {
  h, layout, statusPage, messagePage, loginPage, adminHomePage,
  guestListPage, guestFormPage, deleteConfirmPage, importFormPage, importPreviewPage,
  saveTheDatePage, saveTheDateFormPage,
};
