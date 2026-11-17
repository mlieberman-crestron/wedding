// web.js - small HTTP helpers: sending responses, security headers,
// reading form posts, serving the two static files.

'use strict';

const fs = require('node:fs');
const path = require('node:path');

// Headers added to every HTML page.
//   Content-Security-Policy: the browser may only load styles and scripts
//     from this site (no inline <script>/<style>, nothing from elsewhere),
//     forms may only post back here, and no other site may frame the page.
//     This limits the damage if some text ever slipped through unescaped.
//   X-Frame-Options: the older way of saying "do not put me in a frame".
//   X-Content-Type-Options: browsers must not guess content types.
//   Referrer-Policy: do not leak our URLs (which may contain search terms)
//     to other sites.
const SECURITY_HEADERS = {
  'Content-Security-Policy':
    "default-src 'none'; style-src 'self'; script-src 'self'; img-src 'self'; " +
    "form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
  'X-Frame-Options': 'DENY',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'same-origin',
};

function send(res, status, contentType, body, extraHeaders = {}) {
  res.writeHead(status, {
    'Content-Type': contentType,
    'Content-Length': Buffer.byteLength(body),
    'X-Content-Type-Options': 'nosniff',
    ...extraHeaders,
  });
  res.end(body);
}

// HTML page. Admin pages also get Cache-Control: no-store so guest data is
// not kept in the browser cache.
function sendHtml(res, status, html, extraHeaders = {}) {
  send(res, status, 'text/html; charset=utf-8', html, { ...SECURITY_HEADERS, ...extraHeaders });
}

// 303 See Other: after a POST, the browser follows with a GET, so pressing
// reload does not submit the form again.
function redirect(res, location, extraHeaders = {}) {
  res.writeHead(303, { Location: location, 'Content-Length': 0, ...extraHeaders });
  res.end();
}

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

// Read an application/x-www-form-urlencoded body (what a normal HTML form
// sends) into a URLSearchParams. Bodies over maxBytes are rejected with 413
// without reading them into memory.
function readForm(req, maxBytes) {
  return new Promise((resolve, reject) => {
    const type = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
    const declared = Number(req.headers['content-length'] || 0);
    if (declared > maxBytes) {
      reject(new HttpError(413, `Request too large (limit ${maxBytes} bytes).`));
      return;
    }
    const chunks = [];
    let size = 0;
    let failed = false;
    req.on('data', (chunk) => {
      if (failed) return;
      size += chunk.length;
      if (size > maxBytes) {
        failed = true;
        reject(new HttpError(413, `Request too large (limit ${maxBytes} bytes).`));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (failed) return;
      if (size > 0 && type !== 'application/x-www-form-urlencoded') {
        reject(new HttpError(415, 'Expected a form post (application/x-www-form-urlencoded).'));
        return;
      }
      resolve(new URLSearchParams(Buffer.concat(chunks).toString('utf8')));
    });
    req.on('error', reject);
  });
}

// The only static files. A fixed list means no path tricks (../) are possible.
const STATIC_DIR = path.join(__dirname, 'public');
const STATIC_FILES = {
  '/static/style.css': { file: 'style.css', type: 'text/css; charset=utf-8' },
  '/static/import.js': { file: 'import.js', type: 'text/javascript; charset=utf-8' },
};

// Read both files into memory NOW, while this module is being loaded.
// app.js loads its modules before it drops root privileges, so this read
// happens as root. Reading them later, per request, fails on the NAS: files
// copied over the Windows share are not readable by the unprivileged `node`
// user the server runs as (found in 0.2.0: /static/style.css gave a 500).
// Consequence: after editing a file in public/, restart the container.
for (const entry of Object.values(STATIC_FILES)) {
  entry.body = fs.readFileSync(path.join(STATIC_DIR, entry.file), 'utf8');
}

// Returns true if urlPath was a static file (and it was sent).
function serveStatic(res, urlPath) {
  const entry = STATIC_FILES[urlPath];
  if (!entry) return false;
  // no-cache: the browser re-checks on each load, so an updated file is
  // picked up right after a container restart.
  send(res, 200, entry.type, entry.body, { 'Cache-Control': 'no-cache' });
  return true;
}

// --- Behind a proxy (Cloudflare Tunnel) ---------------------------------------
// Through the tunnel every request reaches the app from the cloudflared
// container, so req.socket.remoteAddress is the same for every visitor.
// Cloudflare puts the visitor's real address in CF-Connecting-IP. That header
// is only believed when trustProxy is on (TRUST_PROXY=true), because anyone
// who can reach the app directly could send it too. On the home LAN that
// risk is accepted: it only affects the login lockout.

const firstHeader = (v) => String(Array.isArray(v) ? v[0] : v || '').split(',')[0].trim();

function clientIp(req, trustProxy) {
  if (trustProxy) {
    const cf = firstHeader(req.headers['cf-connecting-ip']);
    if (cf) return cf;
    const xff = firstHeader(req.headers['x-forwarded-for']);
    if (xff) return xff;
  }
  return (req.socket && req.socket.remoteAddress) || 'unknown';
}

// true when the browser used HTTPS. cloudflared forwards plain HTTP to the
// app and says "https" in X-Forwarded-Proto. Faking this header can only make
// the faker's own cookies Secure (and so break their own login), so it is
// read even without trustProxy.
function isHttps(req) {
  if (req.socket && req.socket.encrypted) return true;
  return firstHeader(req.headers['x-forwarded-proto']).toLowerCase() === 'https';
}

module.exports = { SECURITY_HEADERS, send, sendHtml, redirect, readForm, HttpError, serveStatic, clientIp, isHttps };
