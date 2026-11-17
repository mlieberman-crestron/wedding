// Wedding Platform - entry point (node /app/app.js).
//
// Zero npm dependencies: only Node built-ins (node:http, node:sqlite, ...),
// so there is no `npm install` step and the stock Node image can run it as-is.
// Requires Node >= 22.13 (node:sqlite without the --experimental-sqlite flag).
//
// Module system: CommonJS (require / module.exports). The app folder has no
// package.json, and without one Node loads .js files as CommonJS.
//
// Files in this folder:
//   app.js     this file: startup, privilege drop, HTTP server, routing,
//              the /status page, /health, request log, clean shutdown
//   config.js  settings from environment variables
//   perms.js   data folder ownership and switching away from root
//   db.js      open SQLite + numbered schema migrations
//   guests.js  guest validation, CSV import rules, guest database access
//   savethedate.js  the save-the-date card: validation, calendar file, storage
//   csv.js     CSV parsing and writing
//   auth.js    admin password, sessions, CSRF tokens, login lockout
//   admin.js   the /admin/* pages
//   views.js   HTML for every page (with escaping)
//   web.js     HTTP helpers, security headers, static files
//   backup.js  database backups (also runnable on its own)
//   public/    style.css and import.js, served under /static/

'use strict';

const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');

const config = require('./config');
const { dropPrivileges } = require('./perms');
const { openDatabase, migrate, schemaVersion } = require('./db');
const { createAuth } = require('./auth');
const { createAdmin } = require('./admin');
const views = require('./views');
const saveTheDate = require('./savethedate');
const { send, sendHtml, serveStatic } = require('./web');

const STARTED_AT = new Date();
const log = (message) => console.log(`${new Date().toISOString()} ${message}`);

// ---------------------------------------------------------------------------
// 1. Privilege drop (container-specific; see perms.js for the why).
// If started as root: chown DATA_DIR and everything in it (app.db, journal
// files, backups/) to the node user, then switch to that user for good.
// ---------------------------------------------------------------------------
if (dropPrivileges(config.DATA_DIR, config.DATA_UID, config.DATA_GID)) {
  log(`dropped privileges to uid ${config.DATA_UID}`);
}

// ---------------------------------------------------------------------------
// 2. Database: open, migrate, find our event.
// ---------------------------------------------------------------------------
fs.mkdirSync(config.DATA_DIR, { recursive: true });
const db = openDatabase(config.DB_FILE);
const version = migrate(db, { eventName: config.EVENT_NAME }, log);
log(`database schema version ${version}`);

// One container = one wedding = the first (and only) row in events.
// Keep its name in step with EVENT_NAME in case that setting was changed.
const event = db.prepare('SELECT id, name FROM events ORDER BY id LIMIT 1').get();
const EVENT_ID = event.id;
if (event.name !== config.EVENT_NAME) {
  db.prepare('UPDATE events SET name = ? WHERE id = ?').run(config.EVENT_NAME, EVENT_ID);
  log(`event ${EVENT_ID} renamed to "${config.EVENT_NAME}"`);
}

const incrementVisits = db.prepare(`
  INSERT INTO counter (name, value) VALUES ('visits', 1)
  ON CONFLICT(name) DO UPDATE SET value = value + 1
  RETURNING value`);
const pingDb = db.prepare('SELECT 1 AS ok');

// ---------------------------------------------------------------------------
// 3. Admin login and pages
// ---------------------------------------------------------------------------
if (!config.ADMIN_ENABLED) {
  log(`admin login DISABLED: set ADMIN_PASSWORD (not empty, not ${config.PASSWORD_PLACEHOLDER}) to enable it`);
}
if (config.SIDE_LABELS.a.toLowerCase() === config.SIDE_LABELS.b.toLowerCase()) {
  log('warning: SIDE_A_LABEL and SIDE_B_LABEL are the same; imports cannot tell the sides apart');
}
const auth = createAuth(db, {
  password: config.ADMIN_PASSWORD,
  enabled: config.ADMIN_ENABLED,
  cookieSecure: config.COOKIE_SECURE,
  sessionHours: config.SESSION_HOURS,
  maxFailures: config.LOGIN_MAX_FAILURES,
  lockSeconds: config.LOGIN_LOCK_SECONDS,
});
const handleAdmin = createAdmin({ db, auth, config, eventId: EVENT_ID, log });

// ---------------------------------------------------------------------------
// 4. Public routes
// ---------------------------------------------------------------------------
// /status: the technical status page (version, host, visit counter).
function handleStatus(res) {
  const visits = incrementVisits.get().value;
  const html = views.statusPage(
    {
      appName: config.APP_NAME,
      version: config.VERSION,
      appEnv: config.APP_ENV,
      eventName: config.EVENT_NAME,
      hostname: os.hostname(),
      startedAt: STARTED_AT.toISOString(),
    },
    visits
  );
  sendHtml(res, 200, html);
}

// The save-the-date card. Until it is published, guests get a plain 404 so
// the page does not reveal that anything is planned.
const notFound = (res) => send(res, 404, 'text/plain; charset=utf-8', 'Not found\n');

function handleSaveTheDate(res) {
  const card = saveTheDate.getCard(db, EVENT_ID);
  if (!card || !card.published) return notFound(res);
  const html = views.saveTheDatePage({ card, today: saveTheDate.todayIn(config.TIME_ZONE), publicUrl: config.PUBLIC_URL });
  // no-cache: guests always see the latest wording after an edit.
  return sendHtml(res, 200, html, { 'Cache-Control': 'no-cache' });
}

function handleSaveTheDateIcs(res) {
  const card = saveTheDate.getCard(db, EVENT_ID);
  if (!card || !card.published || !saveTheDate.isValidDate(card.event_date)) return notFound(res);
  const url = config.PUBLIC_URL ? `${config.PUBLIC_URL}/save-the-date` : '';
  const body = saveTheDate.buildIcs(card, { eventId: EVENT_ID, url });
  return send(res, 200, 'text/calendar; charset=utf-8', body, {
    'Content-Disposition': 'attachment; filename="save-the-date.ics"',
    'Cache-Control': 'no-cache',
  });
}

function handleHealth(res) {
  const body = {
    status: 'ok',
    version: config.VERSION,
    db: 'ok',
    schema_version: null,
    uptime_s: Math.round(process.uptime()),
  };
  let status = 200;
  try {
    pingDb.get();
    body.schema_version = schemaVersion(db);
  } catch (err) {
    body.status = 'error';
    body.db = 'error';
    status = 503;
    log(`health: db error: ${err.message}`);
  }
  send(res, status, 'application/json', JSON.stringify(body));
}

// ---------------------------------------------------------------------------
// 5. HTTP server
// ---------------------------------------------------------------------------
async function route(req, res, url) {
  const p = url.pathname;
  // The site's front door is the save-the-date card (404 until published).
  if (req.method === 'GET' && p === '/') return handleSaveTheDate(res);
  if (req.method === 'GET' && p === '/status') return handleStatus(res);
  if (req.method === 'GET' && p === '/health') return handleHealth(res);
  if (req.method === 'GET' && (p === '/save-the-date' || p === '/save-the-date/')) return handleSaveTheDate(res);
  if (req.method === 'GET' && p === '/save-the-date.ics') return handleSaveTheDateIcs(res);
  if (req.method === 'GET' && serveStatic(res, p)) return undefined;
  if (p === '/admin' || p.startsWith('/admin/')) return handleAdmin(req, res, url);
  return notFound(res);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');

  // One log line per request, written when the response is finished.
  // Only the path is logged, not the query string (it may contain searches).
  res.on('finish', () => log(`${req.method} ${url.pathname} ${res.statusCode}`));

  try {
    await route(req, res, url);
  } catch (err) {
    if (err.status) {
      // Expected errors, e.g. 413 body too large. Close the connection so we
      // do not have to read the rest of an oversized upload.
      if (!res.headersSent) {
        send(res, err.status, 'text/plain; charset=utf-8', `${err.message}\n`, { Connection: 'close' });
      }
      return;
    }
    log(`error: ${err.stack}`);
    if (!res.headersSent) send(res, 500, 'text/plain; charset=utf-8', 'Internal error\n');
  }
});

server.listen(config.PORT, () => {
  log(
    `${config.APP_NAME} v${config.VERSION} listening on port ${config.PORT} ` +
      `(APP_ENV=${config.APP_ENV}, db=${config.DB_FILE}, node ${process.version})`
  );
});

// ---------------------------------------------------------------------------
// 6. Clean shutdown: `docker stop` sends SIGTERM; Ctrl+C sends SIGINT.
// Without a handler, Node running as PID 1 in a container ignores SIGTERM and
// Docker waits 10 s before killing it.
// ---------------------------------------------------------------------------
function shutdown(signal) {
  log(`${signal} received, shutting down`);
  server.close(() => {
    db.close();
    log('shutdown complete');
    process.exit(0);
  });
  server.closeAllConnections(); // drop idle keep-alive connections from browsers
  setTimeout(() => process.exit(1), 5000).unref(); // safety net
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
