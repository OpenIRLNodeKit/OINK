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
const ENV_PATH = path.join(noalbsDir, '.env');
fs.writeFileSync(ENV_PATH, [
  '# NOALBS bot creds',
  'TWITCH_BOT_USERNAME=my_bot',
  'TWITCH_BOT_OAUTH=oauth:abc123',
  '',
].join('\n'));

process.env.OINK_STACK_DIR = TMP;
// eslint-disable-next-line import/new-after-exports
const config = require('./config');


test('CONFIG_FILES resolve under the stack dir', () => {
  assert.strictEqual(config.CONFIG_FILES.noalbs, NOALBS_PATH);
  assert.strictEqual(config.CONFIG_FILES.noalbs_env, ENV_PATH);
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

test('validateConfig accepts dotenv text and rejects a non KEY=VALUE line', () => {
  assert.doesNotThrow(() => config.validateConfig('noalbs_env', fs.readFileSync(ENV_PATH, 'utf8')));
  assert.doesNotThrow(() => config.validateConfig('noalbs_env', '# comment\n\nA=1\n'));
  assert.throws(() => config.validateConfig('noalbs_env', 'not a line'), /KEY=VALUE/);
});

test('redactConfig masks the noalbs .env oauth but keeps other lines', () => {
  const redacted = config.redactConfig('noalbs_env', fs.readFileSync(ENV_PATH, 'utf8'));
  assert.ok(!redacted.includes('oauth:abc123'), 'oauth still present');
  assert.ok(redacted.includes('TWITCH_BOT_OAUTH=' + config.REDACTED));
  assert.ok(redacted.includes('TWITCH_BOT_USERNAME=my_bot'));
  assert.ok(redacted.includes('# NOALBS bot creds'));
});

test('restoreConfigSecrets puts the .env oauth back from disk', () => {
  const redacted = config.redactConfig('noalbs_env', fs.readFileSync(ENV_PATH, 'utf8'));
  const restored = config.restoreConfigSecrets('noalbs_env', redacted);
  assert.ok(restored.includes('TWITCH_BOT_OAUTH=oauth:abc123'));
  assert.strictEqual(restored, fs.readFileSync(ENV_PATH, 'utf8'));
});

test('restoreConfigSecrets honors a newly-chosen .env oauth (no marker)', () => {
  const redacted = config.redactConfig('noalbs_env', fs.readFileSync(ENV_PATH, 'utf8'));
  const edited = redacted.replace(config.REDACTED, 'oauth:newtoken');
  const restored = config.restoreConfigSecrets('noalbs_env', edited);
  assert.ok(restored.includes('TWITCH_BOT_OAUTH=oauth:newtoken'));
});

test('setNoalbsChannel writes chat.username and leaves secrets alone', () => {
  const f = path.join(TMP, 'noalbs-channel.json');
  fs.writeFileSync(f, JSON.stringify({
    chat: { admins: ['m'] },
    software: { password: 'P@ssword' },
  }));
  assert.strictEqual(config.setNoalbsChannel('castle_', f), true);
  const parsed = JSON.parse(fs.readFileSync(f, 'utf8'));
  assert.strictEqual(parsed.chat.username, 'castle_');
  assert.deepStrictEqual(parsed.chat.admins, ['m']);
  assert.strictEqual(parsed.software.password, 'P@ssword');
  // Unchanged value and empty name are both no-ops.
  assert.strictEqual(config.setNoalbsChannel('castle_', f), false);
  assert.strictEqual(config.setNoalbsChannel('', f), false);
});

test('setNoalbsChannel creates chat when absent and no-ops on a missing file', () => {
  const f = path.join(TMP, 'noalbs-no-chat.json');
  fs.writeFileSync(f, JSON.stringify({ switcher: {} }));
  assert.strictEqual(config.setNoalbsChannel('my_chan', f), true);
  assert.strictEqual(JSON.parse(fs.readFileSync(f, 'utf8')).chat.username, 'my_chan');
  assert.strictEqual(config.setNoalbsChannel('x', path.join(TMP, 'nope.json')), false);
});

test('pinNoalbsChannel forces chat.username and keeps the rest', () => {
  const content = JSON.stringify({
    chat: { username: 'stale', admins: ['m'] },
    switcher: { low: 1 },
  });
  const parsed = JSON.parse(config.pinNoalbsChannel(content, 'Castle_'));
  assert.strictEqual(parsed.chat.username, 'Castle_');
  assert.deepStrictEqual(parsed.chat.admins, ['m']);
  assert.deepStrictEqual(parsed.switcher, { low: 1 });
});

test('pinNoalbsChannel no-ops on an empty channel or non-object content', () => {
  const content = JSON.stringify({ chat: { username: 'keep' } });
  assert.strictEqual(config.pinNoalbsChannel(content, ''), content);
  assert.strictEqual(config.pinNoalbsChannel('not json', 'x'), 'not json');
  assert.strictEqual(config.pinNoalbsChannel('[1]', 'x'), '[1]');
});
