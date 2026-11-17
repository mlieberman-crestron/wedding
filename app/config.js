// config.js - every setting the app uses, read once from environment variables.
//
// All modules get their settings from here instead of reading process.env
// themselves, so there is one place to see what can be configured.
// Module system: CommonJS (require / module.exports). There is no package.json
// in the mounted app folder, and without one Node treats .js files as CommonJS.

'use strict';

const path = require('node:path');

// Placeholder shipped in portainer-stack.yml / .env.example. While the
// password is unset, empty or still this placeholder, admin login is disabled.
const PASSWORD_PLACEHOLDER = 'CHANGE_ME';

function envString(name, fallback) {
  const value = process.env[name];
  return value === undefined || value.trim() === '' ? fallback : value.trim();
}

const DATA_DIR = envString('DATA_DIR', '/data');
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '';

module.exports = {
  VERSION: '0.3.0',
  APP_NAME: 'Wedding Platform',
  PORT: Number(envString('PORT', '3000')),
  APP_ENV: envString('APP_ENV', 'dev'),
  EVENT_NAME: envString('EVENT_NAME', 'Casey & Dustin'),
  // Time zone for "today" (the save-the-date countdown). IANA name.
  TIME_ZONE: envString('TIME_ZONE', 'America/New_York'),
  // Address guests use to reach the site, e.g. https://casey.caseysplans.com
  // (no trailing slash). Used in calendar entries and, later, in emails.
  // Empty = leave links out.
  PUBLIC_URL: envString('PUBLIC_URL', '').replace(/\/+$/, ''),

  // Storage
  DATA_DIR,
  DB_FILE: path.join(DATA_DIR, 'app.db'),
  BACKUP_DIR: path.join(DATA_DIR, 'backups'),
  BACKUPS_TO_KEEP: 20,

  // uid/gid of the `node` user in the official Node images. When started as
  // root, the app hands DATA_DIR to this user and switches to it.
  DATA_UID: 1000,
  DATA_GID: 1000,

  // Admin login
  ADMIN_PASSWORD,
  ADMIN_ENABLED: ADMIN_PASSWORD.trim() !== '' && ADMIN_PASSWORD !== PASSWORD_PLACEHOLDER,
  PASSWORD_PLACEHOLDER,
  // Secure flag on cookies: 'auto' (default) = only on requests that came in
  // over HTTPS (through Cloudflare), so the login works both at
  // https://caseyanddustin.com and at http://192.168.2.40:8088 on the LAN.
  // 'true' = always (login over plain HTTP then fails), 'false' = never.
  COOKIE_SECURE: (() => {
    const v = envString('COOKIE_SECURE', 'auto').toLowerCase();
    return v === 'true' ? true : v === 'false' ? false : 'auto';
  })(),
  // TRUST_PROXY=true: the app runs behind the Cloudflare Tunnel; take the
  // visitor's address from CF-Connecting-IP (used for the login lockout).
  TRUST_PROXY: envString('TRUST_PROXY', 'false').toLowerCase() === 'true',
  SESSION_HOURS: 12,
  LOGIN_MAX_FAILURES: 5, // failed logins per client IP before a lockout
  LOGIN_LOCK_SECONDS: 60,

  // Labels for the two sides of the guest list. Stored values are always
  // 'a', 'b', 'both' or '' so the code is not tied to one couple.
  SIDE_LABELS: {
    a: envString('SIDE_A_LABEL', 'Casey'),
    b: envString('SIDE_B_LABEL', 'Dustin'),
  },

  // Limits
  MAX_BODY_BYTES: 2 * 1024 * 1024, // larger request bodies get 413
  MAX_IMPORT_ROWS: 5000,
};
