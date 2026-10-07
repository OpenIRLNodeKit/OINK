'use strict';
// SPDX-FileCopyrightText: 2026 OpenIRLNodeKit contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

// Unit tests for stack/proxy.js — the trusted-proxy signal + client-IP choice.

const { test } = require('node:test');
const assert = require('node:assert');

const { trustEnabled, clientIpFor } = require('./proxy');

test('trustEnabled treats unset/falsey as off, anything else as on', () => {
  for (const v of [undefined, null, '', '  ', 'false', 'FALSE', '0', 'no', 'off']) {
    assert.strictEqual(trustEnabled(v), false, `expected ${JSON.stringify(v)} off`);
  }
  for (const v of ['true', '1', 'yes', '127.0.0.1/32', '10.0.0.0/8,192.168.0.0/16']) {
    assert.strictEqual(trustEnabled(v), true, `expected ${JSON.stringify(v)} on`);
  }
});

test('clientIpFor trusts nginx XFF for a loopback peer regardless of signal', () => {
  const req = {
    headers: { 'x-forwarded-for': '203.0.113.9, 10.0.0.1' },
    socket: { remoteAddress: '127.0.0.1' },
  };
  assert.strictEqual(clientIpFor(req), '203.0.113.9');
});

test('clientIpFor falls back to the socket peer without an XFF header', () => {
  const req = { headers: {}, socket: { remoteAddress: '127.0.0.1' } };
  assert.strictEqual(clientIpFor(req), '127.0.0.1');
});

test('clientIpFor ignores XFF from a non-loopback peer (widened bind)', () => {
  const req = {
    headers: { 'x-forwarded-for': '203.0.113.9' },
    socket: { remoteAddress: '192.168.1.50' },
  };
  assert.strictEqual(clientIpFor(req), '192.168.1.50');
});
