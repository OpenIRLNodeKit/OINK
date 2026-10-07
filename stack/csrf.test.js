'use strict';
// SPDX-FileCopyrightText: 2026 OpenIRLNodeKit contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

// Unit tests for stack/csrf.js — Origin/Referer and token checks.

const { test } = require('node:test');
const assert = require('node:assert');

const { isUnsafeMethod, checkOrigin, checkCsrf } = require('./csrf');

test('unsafe methods are POST/PUT/DELETE/PATCH only', () => {
  for (const m of ['POST', 'put', 'Delete', 'PATCH']) assert.ok(isUnsafeMethod(m));
  for (const m of ['GET', 'HEAD', 'OPTIONS', undefined]) assert.ok(!isUnsafeMethod(m));
});

test('checkOrigin matches same-host Origin (port-insensitive) to Host', () => {
  assert.ok(checkOrigin({ headers: { origin: 'http://192.168.8.5:8305', host: '192.168.8.5' } }));
  assert.ok(checkOrigin({ headers: { origin: 'https://box.example', host: 'box.example:8305' } }));
  assert.ok(checkOrigin({ headers: { referer: 'http://box.local:8305/dashboard' , host: 'box.local' } }));
});

test('checkOrigin rejects a cross-site Origin or Referer', () => {
  assert.ok(!checkOrigin({ headers: { origin: 'http://evil.example', host: 'box.local' } }));
  assert.ok(!checkOrigin({ headers: { referer: 'http://evil.example/x', host: 'box.local' } }));
  assert.ok(!checkOrigin({ headers: { origin: 'null', host: 'box.local' } }));
});

test('checkOrigin allows absent Origin/Referer (non-browser clients)', () => {
  assert.ok(checkOrigin({ headers: { host: 'box.local' } }));
});

test('checkCsrf compares header to expected token in constant time', () => {
  const token = 'abc123';
  assert.ok(checkCsrf({ headers: { 'x-csrf-token': token } }, token));
  assert.ok(!checkCsrf({ headers: { 'x-csrf-token': 'nope00' } }, token));
  assert.ok(!checkCsrf({ headers: {} }, token));
  assert.ok(!checkCsrf({ headers: { 'x-csrf-token': token } }, null));
  assert.ok(!checkCsrf({ headers: { 'x-csrf-token': token } }, ''));
});
