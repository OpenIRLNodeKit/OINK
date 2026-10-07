'use strict';
// SPDX-FileCopyrightText: 2026 OpenIRLNodeKit contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

// CSRF defense for the control plane. SameSite=Strict stops the browser from
// attaching the session cookie to cross-site requests; these two checks add the
// OWASP layers that catch a state-changing request the browser did send:
//   1. checkOrigin — the Origin/Referer host must match the box's own Host.
//   2. checkCsrf   — the X-CSRF-Token header must equal the token minted into
//      the signed session at login (double-submit, bound to the session, so a
//      cookie an attacker sets cannot forge it).
// Unsafe methods only; GET/HEAD/OPTIONS are not state-changing.

const crypto = require('crypto');

const CSRF_HEADER = 'x-csrf-token';
const UNSAFE_METHODS = new Set(['POST', 'PUT', 'DELETE', 'PATCH']);

function isUnsafeMethod(method) {
  return UNSAFE_METHODS.has(String(method || '').toUpperCase());
}

function hostnameOf(value) {
  try {
    return new URL(String(value)).hostname.toLowerCase();
  } catch {
    return '';
  }
}

// Browsers set Origin on every cross-site request and on same-origin unsafe
// requests, so a hostname mismatch is a cross-site call. Absent Origin/Referer
// (curl, health probes) is allowed — the CSRF token still gates mutation.
// nginx forwards the client Host, so that is the hostname we expect.
function checkOrigin(req) {
  const source = req.headers.origin || req.headers.referer;
  if (!source) return true;
  const expected = hostnameOf(`http://${req.headers.host || ''}`);
  return expected !== '' && hostnameOf(source) === expected;
}

function checkCsrf(req, expected) {
  if (typeof expected !== 'string' || expected.length === 0) return false;
  const got = String(req.headers[CSRF_HEADER] ?? '');
  if (got.length !== expected.length) return false;
  return crypto.timingSafeEqual(Buffer.from(got), Buffer.from(expected));
}

module.exports = { CSRF_HEADER, isUnsafeMethod, checkOrigin, checkCsrf };
