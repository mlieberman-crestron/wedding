// admin.js - the /admin/* pages.
//
// handleAdmin() is called by app.js for every URL starting with /admin.
// Order of checks for each request:
//   1. login / logout pages are handled first (login needs no session),
//   2. everything else requires a valid session, otherwise -> /admin/login,
//   3. every POST must carry the session's CSRF token, otherwise 403,
//   4. then the route itself runs.

'use strict';

const views = require('./views');
const guests = require('./guests');
const saveTheDate = require('./savethedate');
const { toCsv } = require('./csv');
const { createBackup, listBackups } = require('./backup');
const { schemaVersion } = require('./db');
const { sendHtml, send, redirect, readForm, clientIp: requestIp } = require('./web');

const NO_STORE = { 'Cache-Control': 'no-store' };

// ctx = { db, auth, config, eventId, log }
function createAdmin(ctx) {
  const { db, auth, config, eventId } = ctx;
  const labels = config.SIDE_LABELS;
  const eventName = config.EVENT_NAME;

  const page = (res, html, status = 200) => sendHtml(res, status, html, NO_STORE);

  // Client address used for the login lockout. Behind the Cloudflare Tunnel
  // (TRUST_PROXY=true) this is the visitor's real address from Cloudflare;
  // otherwise the connection's address (which, behind Docker's port
  // publishing, may be the Docker gateway for every LAN client).
  const clientIp = (req) => requestIp(req, config.TRUST_PROXY);

  // Read the guest form fields from a POST body.
  const guestFromForm = (form) => {
    const g = {};
    for (const f of guests.FIELDS) g[f] = form.get(f) || '';
    return g;
  };

  // --- Login / logout ----------------------------------------------------------

  function showLogin(req, res, { error, status = 200 } = {}) {
    const { token, setCookie } = auth.loginToken(req);
    const html = views.loginPage({
      enabled: auth.enabled,
      placeholder: config.PASSWORD_PLACEHOLDER,
      loginToken: token,
      error,
      lockedSeconds: 0,
      eventName,
    });
    sendHtml(res, status, html, { ...NO_STORE, 'Set-Cookie': setCookie });
  }

  async function postLogin(req, res) {
    const form = await readForm(req, config.MAX_BODY_BYTES);
    if (!auth.enabled) return showLogin(req, res, { status: 403 });

    const ip = clientIp(req);
    const locked = auth.throttle.secondsLocked(ip);
    if (locked) {
      const { token, setCookie } = auth.loginToken(req);
      const html = views.loginPage({ enabled: true, loginToken: token, lockedSeconds: locked, eventName });
      return sendHtml(res, 429, html, { ...NO_STORE, 'Set-Cookie': setCookie, 'Retry-After': String(locked) });
    }
    if (!auth.checkLoginCsrf(req, form.get('_csrf'))) {
      return showLogin(req, res, { status: 403, error: 'The form expired. Please try again.' });
    }
    if (!auth.checkPassword(form.get('password') || '')) {
      auth.throttle.recordFailure(ip);
      ctx.log(`admin login failed from ${ip}`);
      return showLogin(req, res, { status: 401, error: 'Wrong password.' });
    }
    auth.throttle.reset(ip);
    ctx.log(`admin login from ${ip}`);
    return redirect(res, '/admin', { 'Set-Cookie': auth.createSession(req) });
  }

  function postLogout(req, res, session) {
    return redirect(res, '/admin/login', { 'Set-Cookie': auth.destroySession(session, req) });
  }

  // --- Admin home and backups ----------------------------------------------------------

  function adminInfo() {
    return {
      eventName,
      version: config.VERSION,
      appEnv: config.APP_ENV,
      schemaVersion: schemaVersion(db),
      labels,
      backupDir: config.BACKUP_DIR,
      backupsToKeep: config.BACKUPS_TO_KEEP,
    };
  }

  function showHome(res, session, { message, error, status = 200 } = {}) {
    page(
      res,
      views.adminHomePage({
        info: adminInfo(),
        counts: guests.countBySide(db, eventId),
        backups: listBackups(config.BACKUP_DIR),
        csrf: session.csrf_token,
        message,
        error,
      }),
      status
    );
  }

  function postBackup(req, res, session) {
    try {
      const { file, deleted } = createBackup(db, config.BACKUP_DIR, config.BACKUPS_TO_KEEP);
      ctx.log(`backup written: ${file}${deleted.length ? `, deleted ${deleted.length} old` : ''}`);
      const name = file.split(/[\\/]/).pop();
      return showHome(res, session, { message: `Backup written: ${name}` });
    } catch (err) {
      ctx.log(`backup failed: ${err.message}`);
      return showHome(res, session, { error: `Backup failed: ${err.message}`, status: 500 });
    }
  }

  // --- Guests ------------------------------------------------------------------

  function showGuests(res, session, url) {
    const search = (url.searchParams.get('q') || '').slice(0, 200);
    page(
      res,
      views.guestListPage({
        guests: guests.listGuests(db, eventId, search),
        counts: guests.countBySide(db, eventId),
        search,
        labels,
        csrf: session.csrf_token,
        eventName,
        done: url.searchParams.get('done'),
        imported: Number(url.searchParams.get('imported')) || 0,
        skipped: Number(url.searchParams.get('skipped')) || 0,
      })
    );
  }

  const emptyGuest = () => Object.fromEntries(guests.FIELDS.map((f) => [f, '']));

  function showGuestForm(res, session, { mode, id, guest, errors, status = 200 }) {
    page(res, views.guestFormPage({ mode, id, guest, errors, labels, csrf: session.csrf_token, eventName }), status);
  }

  function postNewGuest(req, res, session, form) {
    const { guest, errors } = guests.validateGuest(guestFromForm(form), 'form');
    // 422 = "the form had errors"; the page shows them with what was typed.
    if (Object.keys(errors).length) return showGuestForm(res, session, { mode: 'new', guest, errors, status: 422 });
    guests.insertGuest(db, eventId, guest);
    return redirect(res, '/admin/guests?done=added');
  }

  function postEditGuest(req, res, session, form, id) {
    if (!guests.getGuest(db, eventId, id)) return notFound(res, session);
    const { guest, errors } = guests.validateGuest(guestFromForm(form), 'form');
    if (Object.keys(errors).length) return showGuestForm(res, session, { mode: 'edit', id, guest, errors, status: 422 });
    guests.updateGuest(db, eventId, id, guest);
    return redirect(res, '/admin/guests?done=saved');
  }

  function postDeleteGuest(req, res, session, id) {
    if (!guests.deleteGuest(db, eventId, id)) return notFound(res, session);
    return redirect(res, '/admin/guests?done=deleted');
  }

  function exportCsv(res) {
    const header = ['First name', 'Last name', 'Household', 'Email', 'Phone', 'Side', 'Notes', 'Created (UTC)', 'Updated (UTC)'];
    const rows = guests
      .listGuests(db, eventId)
      .map((g) => [g.first_name, g.last_name, g.household, g.email, g.phone, guests.sideLabel(g.side, labels), g.notes, g.created_at, g.updated_at]);
    const date = new Date().toISOString().slice(0, 10);
    send(res, 200, 'text/csv; charset=utf-8', toCsv([header, ...rows]), {
      ...NO_STORE,
      'Content-Disposition': `attachment; filename="guests-${date}.csv"`,
    });
  }

  // --- Import --------------------------------------------------------------------------

  const existingGuests = () => guests.listGuests(db, eventId);
  const planFor = (csv, includeDuplicates) =>
    guests.planImport(csv, existingGuests(), labels, { maxRows: config.MAX_IMPORT_ROWS, includeDuplicates });

  function showImportForm(res, session, { csv, error, status = 200 } = {}) {
    page(
      res,
      views.importFormPage({ csv, error, csrf: session.csrf_token, eventName, maxRows: config.MAX_IMPORT_ROWS, labels }),
      status
    );
  }

  // Step 1: parse and show what would happen. Nothing is written.
  function postImportPreview(req, res, session, form) {
    const csv = form.get('csv') || '';
    const plan = planFor(csv, false);
    if (plan.error) return showImportForm(res, session, { csv, error: plan.error, status: 422 });
    return page(res, views.importPreviewPage({ plan, csv, csrf: session.csrf_token, labels, eventName }));
  }

  // Step 2: parse and check the same text AGAIN (the database may have
  // changed, and nothing from the preview page is trusted), then insert all
  // importable rows in one transaction.
  function postImportCommit(req, res, session, form) {
    const csv = form.get('csv') || '';
    const plan = planFor(csv, form.get('include_duplicates') === '1');
    if (plan.error) return showImportForm(res, session, { csv, error: plan.error, status: 422 });
    const added = guests.importGuests(db, eventId, plan.toImport);
    const skipped = plan.counts.total - added;
    ctx.log(`import: ${added} guests added, ${skipped} rows skipped`);
    return redirect(res, `/admin/guests?done=imported&imported=${added}&skipped=${skipped}`);
  }

  // --- Save the date -------------------------------------------------------------------

  function showSaveTheDate(res, session, { card, errors, done, status = 200 } = {}) {
    page(
      res,
      views.saveTheDateFormPage({
        card: card || saveTheDate.getCard(db, eventId),
        errors,
        done,
        csrf: session.csrf_token,
        eventName,
        publicUrl: config.PUBLIC_URL,
      }),
      status
    );
  }

  function postSaveTheDate(req, res, session, form) {
    const input = Object.fromEntries(saveTheDate.FIELDS.map((f) => [f, form.get(f) || '']));
    input.published = form.get('published') === '1';
    const { std, errors } = saveTheDate.validateCard(input);
    if (Object.keys(errors).length) return showSaveTheDate(res, session, { card: std, errors, status: 422 });
    saveTheDate.saveCard(db, eventId, std);
    ctx.log(`save-the-date saved (${std.published ? 'published' : 'not published'})`);
    return redirect(res, '/admin/save-the-date?done=saved');
  }

  function previewSaveTheDate(res) {
    const card = saveTheDate.getCard(db, eventId);
    page(res, views.saveTheDatePage({ card, today: saveTheDate.todayIn(config.TIME_ZONE), publicUrl: config.PUBLIC_URL, preview: true }));
  }

  function notFound(res, session) {
    page(res, views.messagePage('Not found', 'That page or guest does not exist.', { csrf: session.csrf_token, eventName, backHref: '/admin' }), 404);
  }

  // --- Dispatcher -------------------------------------------------------------------

  return async function handleAdmin(req, res, url) {
    const p = url.pathname.replace(/\/+$/, '') || '/'; // ignore a trailing slash
    const m = req.method;

    if (p === '/admin/login') {
      if (m === 'GET') return auth.getSession(req) ? redirect(res, '/admin') : showLogin(req, res);
      if (m === 'POST') return postLogin(req, res);
      return methodNotAllowed(res);
    }

    const session = auth.getSession(req);
    if (!session) {
      // Not logged in. Drain any body so the connection can be reused.
      req.resume();
      return redirect(res, '/admin/login');
    }

    let form = null;
    if (m === 'POST') {
      form = await readForm(req, config.MAX_BODY_BYTES);
      if (!auth.checkCsrf(session, form.get('_csrf'))) {
        ctx.log(`CSRF check failed for POST ${p}`);
        return page(res, views.messagePage('Request rejected', 'The form was missing its security token or it did not match. Reload the page and try again.', { csrf: session.csrf_token, eventName, backHref: '/admin' }), 403);
      }
    }

    const guestMatch = /^\/admin\/guests\/(\d+)\/(edit|delete)$/.exec(p);
    const id = guestMatch ? Number(guestMatch[1]) : null;

    if (m === 'GET') {
      if (p === '/admin') return showHome(res, session);
      if (p === '/admin/guests') return showGuests(res, session, url);
      if (p === '/admin/guests/new') return showGuestForm(res, session, { mode: 'new', guest: emptyGuest() });
      if (p === '/admin/guests/export.csv') return exportCsv(res);
      if (p === '/admin/guests/import') return showImportForm(res, session);
      if (p === '/admin/save-the-date') return showSaveTheDate(res, session, { done: url.searchParams.get('done') });
      if (p === '/admin/save-the-date/preview') return previewSaveTheDate(res);
      if (guestMatch) {
        const guest = guests.getGuest(db, eventId, id);
        if (!guest) return notFound(res, session);
        if (guestMatch[2] === 'edit') return showGuestForm(res, session, { mode: 'edit', id, guest });
        return page(res, views.deleteConfirmPage({ guest, csrf: session.csrf_token, eventName }));
      }
    }

    if (m === 'POST') {
      if (p === '/admin/logout') return postLogout(req, res, session);
      if (p === '/admin/backup') return postBackup(req, res, session);
      if (p === '/admin/guests/new') return postNewGuest(req, res, session, form);
      if (p === '/admin/guests/import') return postImportPreview(req, res, session, form);
      if (p === '/admin/guests/import/commit') return postImportCommit(req, res, session, form);
      if (p === '/admin/save-the-date') return postSaveTheDate(req, res, session, form);
      if (guestMatch && guestMatch[2] === 'edit') return postEditGuest(req, res, session, form, id);
      if (guestMatch && guestMatch[2] === 'delete') return postDeleteGuest(req, res, session, id);
    }

    return notFound(res, session);
  };
}

function methodNotAllowed(res) {
  send(res, 405, 'text/plain; charset=utf-8', 'Method not allowed\n');
}

module.exports = { createAdmin };
