'use strict';
// SPDX-FileCopyrightText: 2026 OpenIRLNodeKit contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

// Guacamole token hardening: short-lived, single-use, source-IP-bound tokens.
// guacamole-lite (1.2.0) has no expiration, replay protection, or IP binding, so
// the tunnel mints a fresh token per page load and validates it on the WebSocket
// upgrade (server.js `verifyClient`). crypt is injected so this stays pure and
// checkable without starting servers.

const crypto = require('crypto');

function normalizeIp(ip) {
  if (!ip) return '';
  const s = String(ip);
  return s.startsWith('::ffff:') ? s.slice(7) : s; // IPv4-mapped IPv6
}

// Source address of an HTTP/WS request.
function clientIp(req) {
  return normalizeIp(req && req.socket && req.socket.remoteAddress);
}

function createTokenService({ encrypt, decrypt, ttlMs = 120000 }) {
  const used = new Map(); // jti -> exp

  function mint(connection, ip) {
    const now = Date.now();
    for (const [jti, exp] of used) {
      if (exp <= now) used.delete(jti);
    }
    return encrypt({
      connection,
      exp: now + ttlMs,
      jti: crypto.randomUUID(),
      ip: normalizeIp(ip),
    });
  }

  // Returns null when the token is valid, else a short reason string.
  function verify(token, ip) {
    if (!token) return 'missing token';
    let payload;
    try {
      payload = decrypt(String(token));
    } catch {
      return 'undecryptable token';
    }
    if (!payload || typeof payload !== 'object') return 'malformed token';
    if (typeof payload.exp !== 'number' || payload.exp < Date.now()) return 'expired token';
    if (used.has(payload.jti)) return 'token already used';
    if (payload.ip && normalizeIp(ip) !== payload.ip) return 'token ip mismatch';
    used.set(payload.jti, payload.exp);
    return null;
  }

  return { mint, verify };
}

module.exports = { createTokenService, clientIp };

if (require.main === module) {
  const assert = require('assert');
  const fakeEncrypt = (obj) => Buffer.from(JSON.stringify(obj)).toString('base64');
  const fakeDecrypt = (s) => JSON.parse(Buffer.from(s, 'base64').toString('utf-8'));
  const svc = createTokenService({ encrypt: fakeEncrypt, decrypt: fakeDecrypt, ttlMs: 1000 });

  const tok = svc.mint({ type: 'vnc' }, '203.0.113.9');
  assert.strictEqual(svc.verify(tok, '203.0.113.9'), null, 'fresh token verifies');
  assert.strictEqual(svc.verify(tok, '203.0.113.9'), 'token already used', 'replay rejected');
  assert.strictEqual(svc.verify(svc.mint({ type: 'vnc' }, '1.2.3.4'), '5.6.7.8'), 'token ip mismatch');
  assert.strictEqual(svc.verify('garbage', '1.2.3.4'), 'undecryptable token');
  const expired = createTokenService({ encrypt: fakeEncrypt, decrypt: fakeDecrypt, ttlMs: -1000 }).mint({}, '1.2.3.4');
  assert.strictEqual(svc.verify(expired, '1.2.3.4'), 'expired token', 'expired token rejected');
  assert.strictEqual(clientIp({ socket: { remoteAddress: '::ffff:10.0.0.1' } }), '10.0.0.1');

  console.log('guac-token self-check: OK');
}
