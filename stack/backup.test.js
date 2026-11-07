// SPDX-FileCopyrightText: 2026 OpenIRLNodeKit contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
'use strict';

// Env must be set before requiring backup.js (it resolves dirs at load time).
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');
const crypto = require('crypto');

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

// Rewrite an archive with an extra member + manifest entry, mimicking archives
// made before accounts were excluded from backups.
function addLegacyMember(archive, member, content) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oink-legacy-'));
  execFileSync('unzip', ['-q', archive, '-d', dir], { stdio: 'ignore' });
  const dest = path.join(dir, member);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, content);
  const manifestPath = path.join(dir, 'manifest.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
  manifest.files.push({
    path: member,
    sha256: crypto.createHash('sha256').update(content).digest('hex'),
    mode: '0600',
  });
  fs.writeFileSync(manifestPath, JSON.stringify(manifest));
  fs.rmSync(archive);
  const tops = [...new Set(manifest.files.map((f) => f.path.split('/')[0]))];
  execFileSync('zip', ['-q', '-X', '-D', '-r', archive, 'manifest.json', ...tops], {
    cwd: dir, stdio: 'ignore',
  });
  fs.rmSync(dir, { recursive: true, force: true });
}

zipTest('createArchive names by timestamp when no channel', () => {
  seed();
  const { file, dir } = backup.createArchive({});
  assert.match(path.basename(file), /^oink-backup-\d{8}-\d{6}\.zip$/);
  const list = members(file);
  assert.ok(list.includes('manifest.json'));
  assert.ok(!list.includes('stack/users.json'), 'accounts must never enter an archive');
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
  assert.ok(!fs.existsSync(path.join(ROOT, 'stack/users.json')), 'archive carries no accounts');
  assert.ok(fs.existsSync(path.join(ROOT, 'obs/basic/scenes/oink.json')));
  assert.ok(!fs.existsSync(path.join(ROOT, 'stack/api.env')));
  assert.deepStrictEqual(result.skipped, ['stack/api.env']);
  assert.deepStrictEqual(result.failed, []);
  assert.ok(result.touched.stack && result.touched.obs);
  fs.rmSync(dir, { recursive: true, force: true });
});

zipTest('legacy archive accounts are skipped, current users kept', async () => {
  seed();
  write('stack/users.json', '{"users":[{"username":"admin"}]}');
  const { file, dir } = backup.createArchive({});
  // Archives made before the exclusion still carry stack/users.json.
  addLegacyMember(file, 'stack/users.json', '{"users":[{"username":"from-backup"}]}');

  write('stack/users.json', '{"users":[{"username":"current"}]}');
  const result = await backup.restoreArchive(file);
  assert.ok(result.skipped.includes('stack/users.json'));
  assert.match(
    fs.readFileSync(path.join(ROOT, 'stack/users.json'), 'utf-8'),
    /current/,
  );
  fs.rmSync(dir, { recursive: true, force: true });
});

zipTest('restore keeps current OBS websocket password', async () => {
  seed();
  write('stack/noalbs/config.json',
    '{"software":{"password":"source-pw"},"switcher":{}}');
  const { file, dir } = backup.createArchive({});
  write('obs/plugin_config/obs-websocket/password', 'current-pw\n');

  await backup.restoreArchive(file);

  const data = JSON.parse(
    fs.readFileSync(path.join(ROOT, 'stack/noalbs/config.json'), 'utf-8'),
  );
  assert.strictEqual(data.software.password, 'current-pw');
  fs.rmSync(dir, { recursive: true, force: true });
});

zipTest('restore re-points ingest SRT URLs at this box', async () => {
  seed();
  write('obs/basic/scenes/oink.json', JSON.stringify({
    sources: [
      { settings: { url: 'srt://192.168.8.248:8890?streamid=read:live/Key/irl&latency=2000000' } },
      { settings: { url: 'srt://example.com:9000?streamid=read:other' } },
    ],
  }));
  const { file, dir } = backup.createArchive({});

  await backup.restoreArchive(file);

  const data = JSON.parse(
    fs.readFileSync(path.join(ROOT, 'obs/basic/scenes/oink.json'), 'utf-8'),
  );
  assert.strictEqual(
    data.sources[0].settings.url,
    'srt://127.0.0.1:8890?streamid=read:live/Key/irl&latency=2000000',
  );
  assert.strictEqual(
    data.sources[1].settings.url,
    'srt://example.com:9000?streamid=read:other',
  );
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
