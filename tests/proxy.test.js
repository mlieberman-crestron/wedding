// Tests for running behind the Cloudflare Tunnel: visitor address and
// Secure cookies (app/web.js clientIp / isHttps, app/auth.js cookieSecure).
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { clientIp, isHttps } = require('../app/web');
const { openDatabase, migrate } = require('../app/db');
const { createAuth } = require('../app/auth');

const req = (headers = {}, remoteAddress = '172.18.0.3') => ({ headers, socket: { remoteAddress } });

test('client address: Cloudflare header only when the proxy is trusted', () => {
  const r = req({ 'cf-connecting-ip': '203.0.113.7', 'x-forwarded-for': '198.51.100.1, 172.18.0.3' });
  assert.equal(clientIp(r, true), '203.0.113.7');
  assert.equal(clientIp(r, false), '172.18.0.3', 'header ignored without TRUST_PROXY');
  assert.equal(clientIp(req({ 'x-forwarded-for': '198.51.100.1, 10.0.0.1' }), true), '198.51.100.1');
  assert.equal(clientIp(req({}, '192.168.2.15'), true), '192.168.2.15', 'LAN visitor without headers');
  assert.equal(clientIp({ headers: {}, socket: {} }, true), 'unknown');
});

test('HTTPS is recognised from X-Forwarded-Proto', () => {
  assert.equal(isHttps(req({ 'x-forwarded-proto': 'https' })), true);
  assert.equal(isHttps(req({ 'x-forwarded-proto': 'HTTPS, http' })), true);
  assert.equal(isHttps(req({ 'x-forwarded-proto': 'http' })), false);
  assert.equal(isHttps(req({})), false);
});

function authWith(cookieSecure) {
  const db = openDatabase(path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'wedding-test-')), 'app.db'));
  migrate(db, { eventName: 'E' });
  return createAuth(db, { password: 'pw', enabled: true, cookieSecure, sessionHours: 1, maxFailures: 5, lockSeconds: 60 });
}

test("cookieSecure 'auto': Secure over HTTPS, not on the plain-HTTP LAN", () => {
  const auth = authWith('auto');
  const https = req({ 'x-forwarded-proto': 'https' });
  const lan = req({});
  assert.match(auth.createSession(https), /; Secure$/);
  assert.doesNotMatch(auth.createSession(lan), /Secure/);
  assert.match(auth.loginToken(https).setCookie, /; Secure$/);
  assert.doesNotMatch(auth.loginToken(lan).setCookie, /Secure/);
  assert.match(auth.destroySession(null, https), /Max-Age=0; Secure$/);
});

test('cookieSecure true / false are fixed regardless of the request', () => {
  assert.match(authWith(true).createSession(req({})), /; Secure$/);
  assert.doesNotMatch(authWith(false).createSession(req({ 'x-forwarded-proto': 'https' })), /Secure/);
});
