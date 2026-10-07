'use strict';
// SPDX-FileCopyrightText: 2026 OpenIRLNodeKit contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

// Unit tests for stack/config.js — validate, secret redaction + restore on
// the control-plane config endpoints. Uses a temp OINK_STACK_DIR so the module
// reads/writes files it owns (never the real repo/stack dir).

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'oinkcfg-'));
const noalbsDir = path.join(TMP, 'noalbs');
fs.mkdirSync(noalbsDir, { recursive: true });
const NOALBS_PATH = path.join(noalbsDir, 'config.json');
const MEDIAMTX_PATH = path.join(TMP, 'mediamtx.yml');
const KEY = 'AbCdEfGhIjKlMnOpQrStUvWx';

fs.writeFileSync(NOALBS_PATH, JSON.stringify({
  software: { password: 'P@ssword', enabled: true },
  outputs: [{ name: 'twitch', stream_key: 'SK1' }, { name: 'plain', note: 'ok' }],
}, null, 2));
fs.writeFileSync(MEDIAMTX_PATH, [
  'paths:',
  `  live/${KEY}/irl:`,
  '    source: publisher',
  `  ~^live/${KEY}/:`,
  '    source: publisher',
].join('\n'));
fs.writeFileSync(path.join(TMP, 'ingest.json'), JSON.stringify({ version: 1, key: KEY }));

process.env.OINK_STACK_DIR = TMP;
// eslint-disable-next-line import/new-after-exports
const config = require('./config');


test('CONFIG_FILES resolve under the stack dir', () => {
  assert.strictEqual(config.CONFIG_FILES.noalbs, NOALBS_PATH);
  assert.strictEqual(config.CONFIG_FILES.mediamtx, MEDIAMTX_PATH);
});

test('validateConfig accepts a valid noalbs object', () => {
  assert.doesNotThrow(() => config.validateConfig('noalbs', JSON.stringify({ a: 1 })));
});

test('validateConfig rejects a non-object noalbs file', () => {
  assert.throws(() => config.validateConfig('noalbs', JSON.stringify([1, 2, 3])), /object/);
});

test('validateConfig accepts valid mediamtx YAML', () => {
  assert.doesNotThrow(() => config.validateConfig('mediamtx', 'paths:\n  foo: {}'));
});

test('validateConfig rejects invalid mediamtx YAML', () => {
  assert.throws(() => config.validateConfig('mediamtx', 'paths: [unclosed'), /YAML/);
});

test('redactConfig hides the noalbs password and stream keys', () => {
  const redacted = config.redactConfig('noalbs', fs.readFileSync(NOALBS_PATH, 'utf8'));
  assert.ok(!redacted.includes('P@ssword'), 'password still present');
  assert.ok(!redacted.includes('SK1'), 'stream key still present');
  assert.ok(redacted.includes(config.REDACTED));
  // Non-secret fields survive.
  assert.ok(redacted.includes('enabled'));
  assert.ok(redacted.includes('ok'));
});

test('restoreConfigSecrets keeps the real password when editing elsewhere', () => {
  const redacted = config.redactConfig('noalbs', fs.readFileSync(NOALBS_PATH, 'utf8'));
  const restored = config.restoreConfigSecrets('noalbs', redacted);
  const parsed = JSON.parse(restored);
  assert.strictEqual(parsed.software.password, 'P@ssword');
  assert.strictEqual(parsed.outputs[0].stream_key, 'SK1');
  assert.strictEqual(parsed.outputs[1].note, 'ok');
});

test('restoreConfigSecrets honors a newly-chosen password (no marker)', () => {
  const redacted = config.redactConfig('noalbs', fs.readFileSync(NOALBS_PATH, 'utf8'));
  const edited = redacted.replace(config.REDACTED, 'NEWpass');
  const restored = config.restoreConfigSecrets('noalbs', edited);
  assert.strictEqual(JSON.parse(restored).software.password, 'NEWpass');
});

test('redactConfig hides the mediamtx ingest key', () => {
  const redacted = config.redactConfig('mediamtx', fs.readFileSync(MEDIAMTX_PATH, 'utf8'));
  assert.ok(!redacted.includes(KEY), 'ingest key still present');
});

test('restoreConfigSecrets restores the mediamtx ingest key', () => {
  const redacted = config.redactConfig('mediamtx', fs.readFileSync(MEDIAMTX_PATH, 'utf8'));
  const restored = config.restoreConfigSecrets('mediamtx', redacted);
  assert.ok(restored.includes(KEY));
  // Round-trips to valid YAML.
  assert.doesNotThrow(() => config.validateConfig('mediamtx', restored));
});
