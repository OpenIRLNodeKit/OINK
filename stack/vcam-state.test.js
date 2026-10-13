'use strict';
// SPDX-FileCopyrightText: 2026 OpenIRLNodeKit contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

// Unit tests for stack/vcam-state.js — the virtual-camera restore flag.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const vcam = require('./vcam-state');

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'oinkvcam-'));
}

test('flag defaults off and toggles on/off', () => {
  const dir = tmpDir();
  assert.strictEqual(vcam.isWanted(dir), false);
  vcam.setWanted(dir, true);
  assert.strictEqual(vcam.isWanted(dir), true);
  assert.ok(fs.existsSync(vcam.flagPath(dir)));
  vcam.setWanted(dir, false);
  assert.strictEqual(vcam.isWanted(dir), false);
});

test('clearing an already-absent flag is a no-op', () => {
  const dir = tmpDir();
  vcam.setWanted(dir, false);
  assert.strictEqual(vcam.isWanted(dir), false);
});
