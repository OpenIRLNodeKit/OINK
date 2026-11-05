'use strict';
// SPDX-FileCopyrightText: 2026 OpenIRLNodeKit contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

// Unit tests for stack/auth.js — session cookie Secure flag gating + the
// CSRF token minted into the signed session.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { AccountService, canReadLogStream, ROLES } = require('./auth');

function makeService(secureCookies) {
  const stackDir = fs.mkdtempSync(path.join(os.tmpdir(), 'oink-auth-'));
  const svc = new AccountService({
    stackDir,
    sessionSecret: 'test-secret-0123456789',
    adminPassword: 'correct-horse-battery',
    adminPasswordOrigin: 'provided',
    secureCookies,
  });
  const headers = {};
  const res = { setHeader: (k, v) => { headers[k] = v; } };
  const user = svc.authenticate('admin', 'correct-horse-battery');
  return { svc, res, headers, user };
}

function setCookieHeader(headers) {
  const raw = headers['Set-Cookie'];
  return Array.isArray(raw) ? raw.join('; ') : raw;
}

test('session cookie omits Secure by default (plain HTTP)', () => {
  const { svc, res, headers, user } = makeService(false);
  svc.issueSession(user, res);
  assert.ok(setCookieHeader(headers).includes('oink_session='));
  assert.ok(!setCookieHeader(headers).includes('; Secure'));
});

test('session cookie adds Secure behind a TLS proxy', () => {
  const { svc, res, headers, user } = makeService(true);
  svc.issueSession(user, res);
  assert.ok(setCookieHeader(headers).includes('; Secure'));
});

test('logout clears the cookie with matching Secure flag', () => {
  const { svc, res, headers } = makeService(true);
  svc.endSession({}, res);
  assert.ok(setCookieHeader(headers).includes('Max-Age=0'));
  assert.ok(setCookieHeader(headers).includes('; Secure'));
});

test('issueSession sets a readable CSRF cookie bound to the session', () => {
  const { svc, res, headers, user } = makeService(false);
  svc.issueSession(user, res);
  const cookies = headers['Set-Cookie'];
  assert.ok(Array.isArray(cookies) && cookies.length === 2);
  const csrf = cookies.find((c) => c.startsWith('oink_csrf='));
  assert.ok(csrf, 'csrf cookie set');
  assert.ok(!csrf.includes('HttpOnly'), 'csrf cookie readable by JS');
  const cookieHeader = cookies.map((c) => c.split(';')[0]).join('; ');
  const req = { headers: { cookie: cookieHeader } };
  assert.ok(svc.csrfFor(req), 'csrfFor returns the minted token');
  assert.strictEqual(req.headers.cookie.match(/oink_csrf=([^;]*)/)[1], svc.csrfFor(req));
});

test('csrfFor is null without a session (no forgery from a bare cookie)', () => {
  const { svc } = makeService(false);
  assert.strictEqual(svc.csrfFor({ headers: { cookie: 'oink_csrf=planted' } }), null);
  assert.strictEqual(svc.csrfFor({ headers: {} }), null);
});

test('currentUser reads users.json fresh (guac-after-bootstrap race)', () => {
  const stackDir = fs.mkdtempSync(path.join(os.tmpdir(), 'oink-auth-fresh-'));
  const secret = 'test-secret-0123456789';

  // First process: has the admin seed, so it bootstraps users.json.
  const boot = new AccountService({
    stackDir,
    sessionSecret: secret,
    adminPassword: 'correct-horse-battery',
    adminPasswordOrigin: 'provided',
  });
  const headers = {};
  boot.issueSession(boot.authenticate('admin', 'correct-horse-battery'), {
    setHeader: (k, v) => { headers[k] = v; },
  });
  const cookie = headers['Set-Cookie'].find((c) => c.startsWith('oink_session='));
  const req = { headers: { cookie: cookie.split(';')[0] } };
  const savedUsers = fs.readFileSync(path.join(stackDir, 'users.json'), 'utf8');

  // Second process (like oink-guac): no admin seed, started before users.json
  // existed, so it caches an empty store.
  fs.unlinkSync(path.join(stackDir, 'users.json'));
  const guac = new AccountService({ stackDir, sessionSecret: secret });
  assert.strictEqual(guac.currentUser(req), null, 'empty store rejects');

  // oink-api then bootstraps the admin; guac must pick it up without a restart.
  fs.writeFileSync(path.join(stackDir, 'users.json'), savedUsers);
  const user = guac.currentUser(req);
  assert.strictEqual(user?.username, 'admin');
});

test('log streams require operator+, the status feed does not', () => {
  assert.strictEqual(canReadLogStream(ROLES.VIEWER, '/api/ws'), true);
  assert.strictEqual(canReadLogStream(ROLES.VIEWER, '/api/ws?x=1'), true);
  assert.strictEqual(canReadLogStream(ROLES.OPERATOR, '/api/logs/oink-obs'), true);
  assert.strictEqual(canReadLogStream(ROLES.ADMIN, '/api/logs/obs'), true);

  assert.strictEqual(canReadLogStream(ROLES.VIEWER, '/api/logs/oink-obs'), false);
  assert.strictEqual(canReadLogStream(ROLES.VIEWER, '/api/logs/obs'), false);
  assert.strictEqual(canReadLogStream(undefined, '/api/logs/oink-obs'), false);
  assert.strictEqual(canReadLogStream('nonsense', '/api/logs/obs'), false);
});

function sessionReq(headers) {
  const raw = headers['Set-Cookie'];
  const jar = Array.isArray(raw) ? raw : [raw];
  const session = jar.find((c) => c.startsWith('oink_session='));
  return { headers: { cookie: session.split(';')[0] } };
}

test('auth fails closed when accounts exist but the session secret is gone', () => {
  const stackDir = fs.mkdtempSync(path.join(os.tmpdir(), 'oink-auth-'));
  const svc = new AccountService({
    stackDir,
    sessionSecret: '',
    adminPassword: 'correct-horse-battery',
    adminPasswordOrigin: 'provided',
  });
  assert.strictEqual(svc.enabled, false);
  assert.strictEqual(svc.misconfigured, true);
});

test('dev mode (no credentials, no accounts) is not misconfigured', () => {
  const stackDir = fs.mkdtempSync(path.join(os.tmpdir(), 'oink-auth-'));
  const svc = new AccountService({ stackDir });
  assert.strictEqual(svc.enabled, false);
  assert.strictEqual(svc.misconfigured, false);
});

test('setup token creates the admin and is consumed', () => {
  const stackDir = fs.mkdtempSync(path.join(os.tmpdir(), 'oink-auth-'));
  const svc = new AccountService({
    stackDir,
    sessionSecret: 'test-secret-0123456789',
    setupToken: 'setup-token-123',
  });
  assert.strictEqual(svc.setupRequired, true);
  assert.strictEqual(svc.enabled, true);
  assert.throws(
    () => svc.completeSetup('wrong-token', 'admin', 'new-password-123'),
    /Invalid setup token/,
  );
  assert.strictEqual(svc.authenticate('admin', 'new-password-123'), null);
  assert.throws(() => svc.completeSetup('setup-token-123', 'admin', 'short'), /at least 8/);
  assert.throws(
    () => svc.completeSetup('setup-token-123', 'BAD_NAME', 'new-password-123'),
    /Username/,
  );

  const user = svc.completeSetup('setup-token-123', 'Streamer', 'new-password-123');
  assert.strictEqual(user.username, 'streamer');
  assert.strictEqual(user.role, ROLES.ADMIN);
  assert.strictEqual(user.mustChangePassword, false);
  assert.strictEqual(svc.setupRequired, false);
  assert.ok(svc.authenticate('streamer', 'new-password-123'));

  assert.throws(
    () => svc.completeSetup('setup-token-123', 'other', 'another-password'),
    /already completed/,
  );
});

test('password change revokes outstanding sessions', () => {
  const { svc, res, headers, user } = makeService(false);
  svc.issueSession(user, res);
  const req = sessionReq(headers);
  assert.strictEqual(svc.currentUser(req)?.username, 'admin');

  svc.changePassword('admin', 'correct-horse-battery', 'new-password-123');
  assert.strictEqual(svc.currentUser(req), null, 'old token must be rejected');

  const fresh = svc.authenticate('admin', 'new-password-123');
  const res2 = { setHeader: (k, v) => { headers[k] = v; } };
  svc.issueSession(fresh, res2);
  assert.strictEqual(svc.currentUser(sessionReq(headers))?.username, 'admin');
});

test('disabling a user revokes their sessions', () => {
  const { svc, res, headers } = makeService(false);
  svc.createUser({ username: 'cam', role: ROLES.OPERATOR, password: 'operator-pass' });
  svc.issueSession(svc.authenticate('cam', 'operator-pass'), res);
  const req = sessionReq(headers);
  assert.strictEqual(svc.currentUser(req)?.username, 'cam');

  svc.setUserDisabled('cam', true);
  assert.strictEqual(svc.currentUser(req), null);
});
