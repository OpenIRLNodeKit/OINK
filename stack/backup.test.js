// SPDX-FileCopyrightText: 2026 OpenIRLNodeKit contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
'use strict';

// Env must be set before requiring backup.js (it resolves dirs at load time).
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'oink-btest-'));
process.env.OINK_STACK_DIR = path.join(ROOT, 'stack');
process.env.OBS_LOG_DIR = path.join(ROOT, 'obs', 'logs');
process.env.OBS_ASSET_DIR = path.join(ROOT, 'deps');
process.env.OBS_RECORDING_DIR = path.join(ROOT, 'recs');
fs.mkdirSync(process.env.OINK_STACK_DIR, { recursive: true });
fs.copyFileSync(
  path.join(__dirname, 'backup-set.json'),
  path.join(process.env.OINK_STACK_DIR, 'backup-set.json'),
);

const test = require('node:test');
const assert = require('node:assert');
const backup = require('./backup');

// zip/unzip are external binaries; skip the archive round-trip tests when the
// host lacks them instead of failing ENOENT and losing coverage silently.
const hasBin = (cmd) => spawnSync(cmd, ['-v'], { stdio: 'ignore' }).status === 0;
const zipTest = hasBin('zip') && hasBin('unzip') ? test : test.skip;

function write(rel, content) {
  const p = path.join(ROOT, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content);
}

function seed() {
  write('stack/users.json', '{"users":[]}');
  write('stack/ingest.json', '{"version":1,"key":"SeededKey_0123456789abc"}');
  write('stack/api.env', 'OINK_SESSION_SECRET=x\n');
  write('stack/mediamtx.yml', 'paths:\n');
  write('stack/noalbs/config.json', '{"switcher":{}}');
  write('stack/noalbs/.env', 'TWITCH_BOT_OAUTH=oauth:x\n');
  write('stack/assets/avatars/a.png', 'png');
  write('obs/global.ini', '[General]\n');
  write('obs/basic/scenes/oink.json', '{"canvases":[]}');
}

function members(archive) {
  return execFileSync('unzip', ['-Z1', archive], { encoding: 'utf-8' })
    .split('\n')
    .filter(Boolean)
    .map((s) => s.replace(/\/+$/, ''));
}

zipTest('createArchive names by timestamp when no channel', () => {
  seed();
  const { file, dir } = backup.createArchive({});
  assert.match(path.basename(file), /^oink-backup-\d{8}-\d{6}\.zip$/);
  const list = members(file);
  assert.ok(list.includes('manifest.json'));
  assert.ok(list.includes('stack/users.json'));
  assert.ok(list.includes('obs/basic/scenes/oink.json'));
  assert.ok(list.includes('stack/api.env'));
  fs.rmSync(dir, { recursive: true, force: true });
});

zipTest('channel name is slugged into the filename', () => {
  seed();
  const { file, dir } = backup.createArchive({ channel: 'My Channel!! 2026' });
  assert.match(path.basename(file), /^oink-backup-My-Channel-2026-\d{8}-\d{6}\.zip$/);
  fs.rmSync(dir, { recursive: true, force: true });
});

zipTest('assets/recordings are opt-in', () => {
  seed();
  write('deps/clip.png', 'x');
  const off = backup.createArchive({});
  assert.ok(!members(off.file).some((m) => m.startsWith('assets/')));
  fs.rmSync(off.dir, { recursive: true, force: true });

  const on = backup.createArchive({ assets: true });
  assert.ok(members(on.file).some((m) => m.startsWith('assets/')));
  fs.rmSync(on.dir, { recursive: true, force: true });
});

zipTest('restore round-trips files but skips api.env', async () => {
  seed();
  const { file, dir } = backup.createArchive({});
  fs.rmSync(path.join(ROOT, 'stack'), { recursive: true, force: true });
  fs.rmSync(path.join(ROOT, 'obs'), { recursive: true, force: true });
  // backup-set.json lives in the stack dir; keep it so restore can read the set.
  fs.mkdirSync(process.env.OINK_STACK_DIR, { recursive: true });
  fs.copyFileSync(
    path.join(__dirname, 'backup-set.json'),
    path.join(process.env.OINK_STACK_DIR, 'backup-set.json'),
  );

  const result = await backup.restoreArchive(file);
  assert.ok(fs.existsSync(path.join(ROOT, 'stack/users.json')));
  assert.ok(fs.existsSync(path.join(ROOT, 'obs/basic/scenes/oink.json')));
  assert.ok(!fs.existsSync(path.join(ROOT, 'stack/api.env')));
  assert.deepStrictEqual(result.skipped, ['stack/api.env']);
  assert.deepStrictEqual(result.failed, []);
  assert.ok(result.touched.stack && result.touched.obs);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('validateMembers rejects traversal and unknown paths', () => {
  assert.throws(() => backup.validateMembers(['../evil']), /unsafe|outside/);
  assert.throws(() => backup.validateMembers(['/etc/passwd']), /unsafe|outside/);
  assert.throws(() => backup.validateMembers(['etc/passwd']), /unsafe|outside/);
  assert.throws(() => backup.validateMembers(['stack/../../etc/x']), /unsafe|outside/);
  assert.deepStrictEqual(backup.validateMembers(['stack/users.json']), ['stack/users.json']);
  assert.deepStrictEqual(
    backup.validateMembers(['obs/basic/scenes/anything.json']),
    ['obs/basic/scenes/anything.json'],
  );
});
