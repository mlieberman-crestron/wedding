// auth.js - admin login: password check, sessions, CSRF tokens, lockout.
//
// How it works:
//   - There is one shared admin password (env ADMIN_PASSWORD).
//   - Logging in creates a session: a random token sent to the browser in a
//     cookie. The database stores only a SHA-256 hash of the token, plus the
//     expiry time and the session's CSRF token.
//   - CSRF ("cross-site request forgery") protection: every form that changes
//     something carries a hidden field _csrf with a secret value tied to the
//     session. Another website can make your browser POST to this site (and
//     the browser would add the cookie), but it cannot read the secret, so
//     its POST is rejected.
//   - The login form itself has no session yet, so it uses a "double submit"
//     token: the same random value in a short-lived cookie and in a hidden
//     field; the POST must carry both and they must match.
//   - After LOGIN_MAX_FAILURES wrong passwords from one client IP, that IP is
//     locked out for LOGIN_LOCK_SECONDS (kept in memory; a restart clears it).

'use strict';

const crypto = require('node:crypto');
const { nowIso } = require('./db');
const { isHttps } = require('./web');

const SESSION_COOKIE = 'wsid';
const LOGIN_CSRF_COOKIE = 'wlogin';

const randomToken = () => crypto.randomBytes(32).toString('base64url');
const sha256 = (s) => crypto.createHash('sha256').update(String(s)).digest();

// Compare two secrets in constant time (the time taken does not reveal how
// many leading characters matched). Hashing first gives equal-length inputs,
// which timingSafeEqual requires.
function safeEqual(a, b) {
  return crypto.timingSafeEqual(sha256(a), sha256(b));
}

// --- Cookies -----------------------------------------------------------------

function parseCookies(header) {
  const out = {};
  for (const part of String(header || '').split(';')) {
    const i = part.indexOf('=');
    if (i === -1) continue;
    const name = part.slice(0, i).trim();
    if (name && !(name in out)) out[name] = part.slice(i + 1).trim();
  }
  return out;
}

// Build a Set-Cookie header value. Our values are base64url, so no encoding.
function cookie(name, value, { maxAgeSeconds, secure }) {
  let c = `${name}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSeconds}`;
  if (secure) c += '; Secure';
  return c;
}

// --- Login throttle ------------------------------------------------------------

function createLoginThrottle({ maxFailures, lockSeconds }) {
  const byIp = new Map(); // ip -> { failures, lockedUntil }
  return {
    // Seconds until the IP may try again, or 0 if it is not locked.
    secondsLocked(ip, now = Date.now()) {
      const e = byIp.get(ip);
      return e && e.lockedUntil > now ? Math.ceil((e.lockedUntil - now) / 1000) : 0;
    },
    recordFailure(ip, now = Date.now()) {
      if (byIp.size > 10000) byIp.clear(); // crude memory cap
      const e = byIp.get(ip) || { failures: 0, lockedUntil: 0 };
      e.failures++;
      if (e.failures >= maxFailures) {
        e.lockedUntil = now + lockSeconds * 1000;
        e.failures = 0;
      }
      byIp.set(ip, e);
    },
    reset(ip) {
      byIp.delete(ip);
    },
  };
}

// --- Sessions ------------------------------------------------------------------

// options: { password, enabled, cookieSecure, sessionHours, maxFailures, lockSeconds }
// cookieSecure: true, false, or 'auto' (Secure only when this request came
// in over HTTPS; see web.isHttps).
function createAuth(db, options) {
  const secureFor = (req) => (options.cookieSecure === 'auto' ? Boolean(req && isHttps(req)) : Boolean(options.cookieSecure));
  const maxAgeSeconds = options.sessionHours * 3600;
  const throttle = createLoginThrottle(options);

  const insertSession = db.prepare('INSERT INTO sessions (id, csrf_token, created_at, expires_at) VALUES (?, ?, ?, ?)');
  const findSession = db.prepare('SELECT id, csrf_token, expires_at FROM sessions WHERE id = ? AND expires_at > ?');
  const deleteSession = db.prepare('DELETE FROM sessions WHERE id = ?');
  const purgeExpired = db.prepare('DELETE FROM sessions WHERE expires_at <= ?');

  return {
    enabled: options.enabled,
    throttle,

    checkPassword(candidate) {
      return options.enabled && safeEqual(candidate, options.password);
    },

    // Returns the Set-Cookie value for the new session.
    createSession(req) {
      purgeExpired.run(nowIso());
      const token = randomToken();
      const expires = new Date(Date.now() + maxAgeSeconds * 1000).toISOString();
      insertSession.run(sha256(token).toString('hex'), randomToken(), nowIso(), expires);
      return cookie(SESSION_COOKIE, token, { maxAgeSeconds, secure: secureFor(req) });
    },

    // The valid session for this request, or null. Expired sessions do not match.
    getSession(req) {
      if (!options.enabled) return null; // password removed -> nobody is logged in
      const token = parseCookies(req.headers.cookie)[SESSION_COOKIE];
      if (!token) return null;
      return findSession.get(sha256(token).toString('hex'), nowIso()) || null;
    },

    // Returns the Set-Cookie value that removes the cookie.
    destroySession(session, req) {
      if (session) deleteSession.run(session.id);
      return cookie(SESSION_COOKIE, '', { maxAgeSeconds: 0, secure: secureFor(req) });
    },

    checkCsrf(session, submitted) {
      return Boolean(session && typeof submitted === 'string' && submitted !== '' && safeEqual(submitted, session.csrf_token));
    },

    // Login form CSRF (double submit). loginToken() returns the token for the
    // form and the cookie to set (reusing the browser's existing token, so two
    // open login tabs both work); checkLoginCsrf() compares cookie and field.
    loginToken(req) {
      const existing = parseCookies(req.headers.cookie)[LOGIN_CSRF_COOKIE];
      const token = existing && /^[A-Za-z0-9_-]{43}$/.test(existing) ? existing : randomToken();
      return { token, setCookie: cookie(LOGIN_CSRF_COOKIE, token, { maxAgeSeconds: 3600, secure: secureFor(req) }) };
    },
    checkLoginCsrf(req, submitted) {
      const fromCookie = parseCookies(req.headers.cookie)[LOGIN_CSRF_COOKIE];
      return Boolean(fromCookie && typeof submitted === 'string' && submitted !== '' && safeEqual(fromCookie, submitted));
    },
  };
}

module.exports = { createAuth, createLoginThrottle, parseCookies, safeEqual };
