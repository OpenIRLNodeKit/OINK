// SPDX-FileCopyrightText: 2026 OpenIRLNodeKit contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Unit tests for stack/ingest.js (node:test — zero-dep, Node 22 native).
 * Run: node --test stack/ingest.test.js
 */
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const yaml = require('js-yaml');

const ingest = require('./ingest');

const MTX_TPL = `authInternalUsers:
  - user: any
    pass:
    ips: []
    permissions:
      - action: publish
        path: ~^live/__STREAM_KEY__/
      - action: read
        path: ~^live/__STREAM_KEY__/
paths:
  live/__STREAM_KEY__/irl:
    source: publisher
  ~^live/__STREAM_KEY__/:
    source: publisher
`;

function tmpStack(initialKey, { seedState = true } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oink-ingest-'));
  fs.mkdirSync(path.join(dir, 'noalbs'), { recursive: true });
  const mtx = MTX_TPL.split('__STREAM_KEY__').join(initialKey);
  fs.writeFileSync(path.join(dir, 'mediamtx.yml'), mtx);
  fs.writeFileSync(path.join(dir, 'noalbs', 'config.json'),
    JSON.stringify({
      switcher: {
        streamServers: [{
          streamServer: {
            type: 'Mediamtx',
            statsUrl: `http://127.0.0.1:9997/v3/paths/get/live/${initialKey}/irl`,
            publisher: '',
          },
        }],
      },
    }, null, 2));
  if (seedState && ingest.isValidKey(initialKey)) {
    fs.writeFileSync(path.join(dir, ingest.INGEST_FILE),
      JSON.stringify({ version: 1, key: initialKey, createdAt: 1, updatedAt: 1 }));
  }
  return dir;
}

test('ensureState creates a 0600 ingest.json with a valid key', () => {
  const dir = tmpStack('AbC123xYz', { seedState: false });
  const state = ingest.ensureState(dir);
  assert.ok(ingest.isValidKey(state.key));
  const mode = fs.statSync(path.join(dir, ingest.INGEST_FILE)).mode & 0o777;
  assert.strictEqual(mode, 0o600);
  // existing key is preserved on second call
  assert.strictEqual(ingest.ensureState(dir).key, state.key);
});

test('ensureState keeps an existing operator/py-generated key', () => {
  const dir = tmpStack('AbC123xYz', { seedState: false });
  const key = 'ExistingKey_1234567890123';
  fs.writeFileSync(path.join(dir, ingest.INGEST_FILE),
    JSON.stringify({ version: 1, key, createdAt: 1, updatedAt: 1 }));
  assert.strictEqual(ingest.ensureState(dir).key, key);
});

test('ensureState uses a valid seed key, ignores an invalid one', () => {
  const dir = tmpStack('AbC123xYz', { seedState: false });
  const seed = 'SeededKey_0123456789abc';
  assert.strictEqual(ingest.ensureState(dir, seed).key, seed);
  const dir2 = tmpStack('AbC123xYz', { seedState: false });
  const generated = ingest.ensureState(dir2, 'too-short').key;
  assert.ok(ingest.isValidKey(generated));
  assert.notStrictEqual(generated, 'too-short');
});

test('bootstrap passes the seed key into the rendered mediamtx.yml', () => {
  const dir = tmpStack('AbC123xYz', { seedState: false });
  const tpl = path.join(dir, 'mediamtx.template.yml');
  fs.writeFileSync(tpl, MTX_TPL);
  const seed = 'BootstrapSeed_012345678';
  const state = ingest.bootstrap(dir, tpl, seed);
  assert.strictEqual(state.key, seed);
  assert.ok(fs.readFileSync(path.join(dir, 'mediamtx.yml'), 'utf8').includes(seed));
});

test('isValidKey rejects short / unsafe keys', () => {
  assert.ok(!ingest.isValidKey('short'));
  assert.ok(!ingest.isValidKey('has space and spaces 12345'));
  assert.ok(!ingest.isValidKey('has/slash/12345678'));
  assert.ok(ingest.isValidKey('abcXYZ_0123456789-abcdef'));
});

test('canonicalPath and namespacePrefix', () => {
  assert.strictEqual(ingest.canonicalPath('kEy-1', 'main'), 'live/kEy-1/main');
  assert.strictEqual(ingest.namespacePrefix('kEy-1'), 'live/kEy-1/');
  assert.strictEqual(
    ingest.noalbsStatsUrl('kEy-1'),
    'http://127.0.0.1:9997/v3/paths/get/live/kEy-1/irl',
  );
});

test('applyStreamKey rewrites mediamtx.yml + noalbs and updates state', () => {
  const dir = tmpStack('OldKey_123456789012345');
  const res = ingest.applyStreamKey(dir, 'NewKey_123456789012345');
  assert.deepStrictEqual(res.changed.sort(), ['mediamtx.yml', 'noalbs/config.json'].sort());

  const mtx = fs.readFileSync(path.join(dir, 'mediamtx.yml'), 'utf8');
  assert.ok(!mtx.includes('OldKey_123456789012345'));
  assert.ok(mtx.includes('~^live/NewKey_123456789012345/'));
  assert.ok(mtx.includes('live/NewKey_123456789012345/irl'));

  const parsed = yaml.load(mtx);
  assert.ok(parsed.paths['~^live/NewKey_123456789012345/']);
  assert.ok(parsed.paths['live/NewKey_123456789012345/irl']);
  assert.ok(!('all_others' in parsed.paths));

  const noalbs = JSON.parse(fs.readFileSync(path.join(dir, 'noalbs', 'config.json'), 'utf8'));
  assert.strictEqual(
    noalbs.switcher.streamServers[0].streamServer.statsUrl,
    'http://127.0.0.1:9997/v3/paths/get/live/NewKey_123456789012345/irl',
  );
  assert.strictEqual(ingest.readState(dir).key, 'NewKey_123456789012345');

  // backup of the pre-rotation mediamtx.yml exists
  assert.ok(fs.existsSync(path.join(dir, 'mediamtx.yml.bak')));
});

test('applyStreamKey with same key is a no-op', () => {
  const dir = tmpStack('SameKey_123456789012345');
  const state = ingest.ensureState(dir);
  const res = ingest.applyStreamKey(dir, state.key);
  assert.deepStrictEqual(res.changed, []);
});

test('applyStreamKey throws when mediamtx.yml diverged from the key', () => {
  const dir = tmpStack('StateKey_1234567890123');
  fs.writeFileSync(path.join(dir, 'mediamtx.yml'),
    'paths:\n  live/DivergedKey_1234567890123/irl:\n    source: publisher\n');
  assert.throws(() => ingest.applyStreamKey(dir, 'NewKey_123456789012345'),
    /does not reference the keyed namespace/);
});

test('bootstrap creates a 0600 key and renders mediamtx.yml from the template', () => {
  const dir = tmpStack('AbC123xYz', { seedState: false });
  const state = ingest.bootstrap(dir, path.join(__dirname, 'mediamtx.yml'));
  assert.ok(ingest.isValidKey(state.key));
  assert.strictEqual((fs.statSync(path.join(dir, ingest.INGEST_FILE)).mode & 0o777), 0o600);

  const mtx = fs.readFileSync(path.join(dir, 'mediamtx.yml'), 'utf8');
  assert.ok(!mtx.includes('__STREAM_KEY__'));
  assert.ok(mtx.includes(`~^live/${state.key}/`));
  assert.ok(mtx.includes(`live/${state.key}/irl`));
});

test('bootstrap renders against the pinned repo template (no all_others)', () => {
  const dir = tmpStack('AbC123xYz', { seedState: false });
  const state = ingest.bootstrap(dir, path.join(__dirname, 'mediamtx.yml'));
  const parsed = yaml.load(fs.readFileSync(path.join(dir, 'mediamtx.yml'), 'utf8'));
  assert.ok(parsed.paths[`live/${state.key}/irl`]);
  assert.ok(parsed.paths[`~^live/${state.key}/`]);
  assert.ok(!('all_others' in parsed.paths));
});

test('bootstrap is idempotent and recovers a malformed ingest.json', () => {
  const dir = tmpStack('AbC123xYz', { seedState: false });
  fs.writeFileSync(path.join(dir, ingest.INGEST_FILE), '{not json');
  const first = ingest.bootstrap(dir, path.join(__dirname, 'mediamtx.yml'));
  const second = ingest.bootstrap(dir, path.join(__dirname, 'mediamtx.yml'));
  assert.strictEqual(second.key, first.key);
  assert.ok(ingest.isValidKey(first.key));
});

test('bootstrap throws when the template file is missing', () => {
  const dir = tmpStack('AbC123xYz', { seedState: false });
  assert.throws(() => ingest.bootstrap(dir, path.join(dir, 'does-not-exist.yml')),
    /mediamtx template not found/);
});

test('normalizeProfiles trims, de-dupes and rejects bad labels', () => {
  assert.deepStrictEqual(ingest.normalizeProfiles([' test ', 'angle-1', 'test']),
    ['test', 'angle-1']);
  assert.deepStrictEqual(ingest.normalizeProfiles([]), []);
  assert.throws(() => ingest.normalizeProfiles('nope'), /must be an array/);
  assert.throws(() => ingest.normalizeProfiles([42]), /must be a string/);
  assert.throws(() => ingest.normalizeProfiles(['has space']), /invalid profile/);
  assert.throws(() => ingest.normalizeProfiles(['bad/slash']), /invalid profile/);
  assert.throws(() => ingest.normalizeProfiles(['x'.repeat(65)]), /invalid profile/);
});

test('normalizeProfileState always keeps the reserved irl feed and a valid main', () => {
  assert.deepStrictEqual(ingest.normalizeProfileState({ profiles: ['test'], main: 'test' }),
    { profiles: ['irl', 'test'], main: 'test' });
  assert.deepStrictEqual(ingest.normalizeProfileState({ profiles: ['irl'] }),
    { profiles: ['irl'], main: 'irl' });
  assert.deepStrictEqual(ingest.normalizeProfileState(null),
    { profiles: ['irl'], main: 'irl' });
});

test('readProfileState defaults to the reserved irl feed; write persists 0600', () => {
  const dir = tmpStack('AbC123xYz', { seedState: false });
  assert.deepStrictEqual(ingest.readProfileState(dir),
    { profiles: ['irl'], main: 'irl' });

  assert.deepStrictEqual(
    ingest.writeProfileState(dir, { profiles: ['test', 'angle1'], main: 'test' }),
    { profiles: ['irl', 'test', 'angle1'], main: 'test' });
  const mode = fs.statSync(path.join(dir, ingest.PROFILES_FILE)).mode & 0o777;
  assert.strictEqual(mode, 0o600);
  assert.deepStrictEqual(ingest.readProfileState(dir),
    { profiles: ['irl', 'test', 'angle1'], main: 'test' });

  // The reserved feed cannot be removed and an unknown main falls back.
  assert.deepStrictEqual(
    ingest.writeProfileState(dir, { profiles: ['test'], main: 'ghost' }),
    { profiles: ['irl', 'test'], main: 'irl' });

  fs.writeFileSync(path.join(dir, ingest.PROFILES_FILE), '{not json');
  assert.deepStrictEqual(ingest.readProfileState(dir),
    { profiles: ['irl'], main: 'irl' });
});

test('setNoalbsMain rewrites the installed statsUrl label and reports change', () => {
  const dir = tmpStack('AbC123xYz', { seedState: false });
  const noalbs = path.join(dir, 'noalbs', 'config.json');
  assert.strictEqual(ingest.setNoalbsMain(dir, 'test'), true);
  const txt = fs.readFileSync(noalbs, 'utf8');
  assert.ok(txt.includes('/v3/paths/get/live/AbC123xYz/test'));
  assert.ok(!txt.includes('/v3/paths/get/live/AbC123xYz/irl'));
  // Same target is a no-op; missing file returns false.
  assert.strictEqual(ingest.setNoalbsMain(dir, 'test'), false);
  fs.unlinkSync(noalbs);
  assert.strictEqual(ingest.setNoalbsMain(dir, 'test'), false);
  assert.throws(() => ingest.setNoalbsMain(dir, 'bad/label'), /invalid monitored/);
});
