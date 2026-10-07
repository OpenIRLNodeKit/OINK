'use strict';
// SPDX-FileCopyrightText: 2026 OpenIRLNodeKit contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

// Unit tests for stack/plugins.js — pinned default manifest, plugin archive
// install with the zip-slip guard, and on-disk presence detection.

const { test } = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

// Point the OBS plugin dir at a temp location before the module reads OBS_LOG_DIR.
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'oinkplug-'));
process.env.OBS_LOG_DIR = path.join(TMP, 'logs');

// eslint-disable-next-line import/new-after-exports
const plugins = require('./plugins');

const PLUGIN_DIR = plugins.OBS_PLUGIN_DIR;
// Ensure the plugin dir exists (the installers mkdtemp a stage under it).
fs.mkdirSync(PLUGIN_DIR, { recursive: true });

function _writePluginRoot(base, name, extra = []) {
  const so = path.join(base, name, 'bin', '64bit', `${name}.so`);
  fs.mkdirSync(path.dirname(so), { recursive: true });
  fs.writeFileSync(so, Buffer.from([0x7f, 0x45, 0x4c, 0x46]));
  for (const rel of extra) {
    const p = path.join(base, name, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, 'x');
  }
  return so;
}

function _tarGz(srcDir, name) {
  const out = path.join(TMP, `${name}.tar.gz`);
  const parent = path.dirname(srcDir);
  execFileSync('tar', ['-czf', out, '-C', parent, path.relative(parent, srcDir)]);
  return out;
}

test('default plugin manifest resolves names + pins', () => {
  const irl = plugins.defaultPlugin('obs-irl-source');
  assert.ok(irl);
  assert.strictEqual(irl.version.length > 0, true);
  assert.match(irl.sha256, /^[0-9a-f]{64}$/);
  assert.strictEqual(plugins.defaultPlugin('no-such-plugin'), null);
});

test('_sha256File matches the expected digest', () => {
  const f = path.join(TMP, 'blob.bin');
  fs.writeFileSync(f, 'hello');
  assert.strictEqual(plugins._sha256File(f), crypto.createHash('sha256').update('hello').digest('hex'));
});

test('_installPluginArchive installs a normal plugin layout', () => {
  const base = path.join(TMP, 'src-normal');
  _writePluginRoot(base, 'my-plugin', ['data/a.ini']);
  const archive = _tarGz(path.join(base, 'my-plugin'), 'my-plugin');

  const res = plugins._installPluginArchive(archive, null);

  assert.strictEqual(res.name, 'my-plugin');
  assert.ok(fs.existsSync(path.join(PLUGIN_DIR, 'my-plugin', 'bin', '64bit', 'my-plugin.so')));
  assert.ok(fs.existsSync(path.join(PLUGIN_DIR, 'my-plugin', 'data', 'a.ini')));
  assert.strictEqual(plugins.pluginInstalled('my-plugin'), true);
});

test('_installPluginArchive refuses an archive with a traversal entry', () => {
  const evil = path.join(TMP, 'evil.tar');
  execFileSync('python3', ['-c', `
import tarfile, sys
t = tarfile.open(sys.argv[1], 'w')
info = tarfile.TarInfo('../escape.so'); info.size = 0
t.addfile(info)
t.close()
`, evil]);
  assert.throws(() => plugins._installPluginArchive(evil, null), /unsafe path/);
});

test('_installPluginArchive refuses replacing a default plugin from an upload', () => {
  // A forged archive whose plugin root is a default (build) name is rejected
  // unless allowDefault is true (the pinned installer path).
  const base = path.join(TMP, 'src-default');
  _writePluginRoot(base, 'obs-irl-source');
  const archive = _tarGz(path.join(base, 'obs-irl-source'), 'obs-irl-source');

  assert.throws(
    () => plugins._installPluginArchive(archive, null),
    /default plugin/,
  );
});

test('pluginInstalled is false for a missing plugin', () => {
  assert.strictEqual(plugins.pluginInstalled('definitely-not-installed-xyz'), false);
});
