'use strict';
// SPDX-FileCopyrightText: 2026 OpenIRLNodeKit contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

// Unit tests for stack/settings.js — the dashboard settings store. Uses a temp
// dir so the module reads/writes files it owns (never the real stack dir).

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const settings = require('./settings');

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'oinksettings-'));
}

test('defaults are all-unset and welcome is incomplete', () => {
  const dir = tmpDir();
  const s = settings.ensureSettings(dir);
  assert.strictEqual(s.welcomeComplete, false);
  assert.strictEqual(s.twitchChannel, '');
  assert.strictEqual(s.presetProvided, false);
  assert.ok(fs.existsSync(settings.settingsPath(dir)));
});

test('seeds from the provided env values on first create', () => {
  const dir = tmpDir();
  const s = settings.ensureSettings(dir, { twitchChannel: 'castle_', presetProvided: true });
  assert.strictEqual(s.twitchChannel, 'castle_');
  assert.strictEqual(s.presetProvided, true);
});

test('existing values persist across a re-seed (dashboard owns them)', () => {
  const dir = tmpDir();
  settings.ensureSettings(dir, { twitchChannel: 'first' });
  const s = settings.ensureSettings(dir, { twitchChannel: 'second', presetProvided: true });
  assert.strictEqual(s.twitchChannel, 'first');
  assert.strictEqual(s.presetProvided, false);
});

test('normalizeChannel trims and rejects invalid names', () => {
  assert.strictEqual(settings.normalizeChannel('  castle_  '), 'castle_');
  assert.strictEqual(settings.normalizeChannel(''), '');
  assert.throws(() => settings.normalizeChannel('bad name'));
  assert.throws(() => settings.normalizeChannel('a'.repeat(26)));
});

test('video presets are valid and cover every name', () => {
  for (const name of Object.keys(settings.VIDEO_PRESETS)) {
    const p = settings.VIDEO_PRESETS[name];
    assert.ok(p.outputWidth > 0 && p.outputHeight > 0);
    assert.ok(p.fps > 0 && p.bitrate > 0);
    assert.ok(settings.isValidPreset(name));
  }
  assert.strictEqual(settings.isValidPreset('2160p60'), false);
});

test('readSettings tolerates a corrupt file', () => {
  const dir = tmpDir();
  fs.writeFileSync(settings.settingsPath(dir), '{not json');
  const s = settings.readSettings(dir);
  assert.strictEqual(s.welcomeComplete, false);
  assert.strictEqual(s.twitchChannel, '');
});
