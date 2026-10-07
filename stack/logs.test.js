// SPDX-FileCopyrightText: 2026 OpenIRLNodeKit contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');

// Point OBS_LOG_DIR at a temp dir BEFORE requiring the module (read at load).
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'oink-logs-test-'));
const OBS = path.join(TMP, 'obs-logs');
fs.mkdirSync(OBS);
fs.writeFileSync(path.join(OBS, '2026-01-01 12-00-00.txt'), 'obs log line\n');
fs.writeFileSync(path.join(OBS, 'ignore.cfg'), 'not a log\n');
process.env.OBS_LOG_DIR = OBS;

const logs = require('./logs');

// zip/unzip are external binaries; skip the archive round-trip when absent.
const hasBin = (cmd) => spawnSync(cmd, ['-v'], { stdio: 'ignore' }).status === 0;
const zipTest = hasBin('zip') && hasBin('unzip') ? test : test.skip;

test('collectObsLogs picks only .log/.txt files', () => {
  const names = logs.collectObsLogs().map((f) => f.name).sort();
  assert.deepStrictEqual(names, ['2026-01-01 12-00-00.txt']);
});

zipTest('createLogsArchive bundles journald + OBS logs + extras', () => {
  const archive = logs.createLogsArchive({
    journalFor: (unit) => `journal for ${unit}\n`,
    extraFiles: { 'versions.txt': 'OINK: test\n' },
  });
  try {
    const members = execFileSync('unzip', ['-Z1', archive.file], { encoding: 'utf-8' })
      .split('\n').filter(Boolean);
    assert.ok(members.includes('journald/oink-mediamtx.log'), 'mediamtx journal present');
    assert.ok(members.includes('journald/oink-noalbs.log'), 'noalbs journal present');
    assert.ok(members.includes('journald/oink-api.log'), 'oink-api journal present');
    assert.ok(members.includes('journald/guacd.log'), 'guacd journal present');
    assert.ok(members.includes('obs/2026-01-01 12-00-00.txt'), 'OBS log present');
    assert.ok(members.includes('versions.txt'), 'versions.txt present');
    assert.ok(members.includes('README.txt'), 'README present');
    assert.ok(!members.includes('obs/ignore.cfg'), 'non-log excluded');
    // 10 journald units + 1 obs + 1 extra + README
    assert.strictEqual(archive.count, 13);

    const mediamtx = execFileSync(
      'unzip',
      ['-p', archive.file, 'journald/oink-mediamtx.log'],
      { encoding: 'utf-8' },
    );
    assert.strictEqual(mediamtx, 'journal for oink-mediamtx\n');
  } finally {
    fs.rmSync(archive.dir, { recursive: true, force: true });
    fs.rmSync(TMP, { recursive: true, force: true });
  }
});
