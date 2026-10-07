'use strict';
// SPDX-FileCopyrightText: 2026 OpenIRLNodeKit contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

// Trusted-proxy handling for the control plane.
//
// OINK_TRUSTED_PROXIES is the single "this box sits behind a fronting proxy"
// signal. When set (to `true`, or a CIDR list the nginx template consumes),
// the API trusts the client IP the fronting proxy put in X-Forwarded-For and
// the dashboard session cookie is marked Secure. The API binds 127.0.0.1, so
// only nginx — which overwrites the header with the real client — can reach
// it. Unset/`false` keeps the plain-HTTP socket-peer behaviour untouched.

const FALSEY = new Set(['', '0', 'false', 'no', 'off']);

function trustEnabled(value) {
  return !FALSEY.has(String(value == null ? '' : value).trim().toLowerCase());
}

// Client IP for rate limiting/audit. The API binds loopback and nginx is the
// only thing that can reach it; nginx overwrites X-Forwarded-For with
// $remote_addr, so trust it whenever the direct peer is loopback — independent
// of the TLS-proxy signal. Keying on the socket peer instead would collapse
// every client into one bucket (global login lockout / API 429s). If an
// operator widens API_BIND_HOST, direct peers aren't loopback, so XFF stays
// untrusted.
function clientIpFor(req) {
  const peer = req.socket.remoteAddress || '';
  const loopback = peer === '127.0.0.1' || peer === '::1' || peer === '::ffff:127.0.0.1';
  if (loopback) {
    const xff = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
    if (xff) return xff;
  }
  return peer || 'unknown';
}

module.exports = { trustEnabled, clientIpFor };
