// SPDX-FileCopyrightText: 2026 OpenIRLNodeKit contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const disk = require('./disk');

test('freeBytes reports writable space for an existing directory', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'disk-free-'));
  try {
    assert.ok(disk.freeBytes(dir) > 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('usage merges directories on the same device and skips missing ones', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'disk-usage-'));
  const sub = path.join(dir, 'recordings');
  fs.mkdirSync(sub);
  try {
    const rows = disk.usage([
      { label: 'Assets', dir },
      { label: 'Recordings', dir: sub },
      { label: 'Missing', dir: path.join(dir, 'absent') },
    ]);
    assert.strictEqual(rows.length, 1);
    assert.strictEqual(rows[0].label, 'Assets · Recordings');
    assert.strictEqual(rows[0].paths.length, 2);
    assert.ok(rows[0].total > 0);
    assert.ok(rows[0].free >= 0);
    assert.ok(rows[0].used >= 0);
    assert.ok(rows[0].percent >= 0 && rows[0].percent <= 100);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
