// SPDX-FileCopyrightText: 2026 OpenIRLNodeKit contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
'use strict';

/**
 * logs.js — dashboard-side log bundle.
 *
 * Builds the "download all logs" .zip for the Versions tab: every OINK systemd
 * unit (plus distro guacd) from journald, every OBS log file under OBS_LOG_DIR,
 * plus caller-supplied extras (versions.txt) and a README. Archives are `.zip`,
 * built with the system `zip` binary — the same dependency backup.js uses.
 *
 * Logs leak secrets (obs-websocket password, stream keys), so the route that
 * calls this is operator/admin-only, like the live log streams.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const OBS_LOG_DIR = process.env.OBS_LOG_DIR || '/obs-logs';

// Every systemd unit the stack installs (see scripts/status.py) plus distro
// guacd. Journald window: last 3 days, capped so a chatty unit can't produce a
// huge archive. `-o short-iso` keeps timestamps for issue triage.
const JOURNAL_UNITS = [
  'oink-api',
  'oink-display',
  'oink-firewall',
  'oink-guac',
  'oink-mediamtx',
  'oink-nginx',
  'oink-noalbs',
  'oink-obs',
  'oink-vnc',
  'guacd',
];
const JOURNAL_MAX_LINES = 20000;
const JOURNAL_SINCE = '3 days ago';

const README = `OpenIRLNodeKit log bundle
=========================

journald/         systemd journals, last 3 days:
                  oink-api, oink-display, oink-firewall, oink-guac,
                  oink-mediamtx, oink-nginx, oink-noalbs, oink-obs,
                  oink-vnc, guacd
obs/              OBS Studio's own log files
versions.txt      Component versions of this install

Attach this .zip to a GitHub issue:
https://github.com/OpenIRLNodeKit/OINK/issues/new
`;

function defaultJournalFor(unit) {
  try {
    return execFileSync(
      'journalctl',
      ['-u', unit, '--no-pager', '-o', 'short-iso',
        '--since', JOURNAL_SINCE, '-n', String(JOURNAL_MAX_LINES)],
      { encoding: 'utf-8', maxBuffer: 256 * 1024 * 1024, timeout: 60000 },
    );
  } catch (e) {
    // Never fail the whole bundle because one unit's journal is unreadable.
    return `[oink] could not read journald for ${unit}: ${e.message}\n`;
  }
}

// Every .log/.txt file OBS itself wrote (the same filter the live OBS tail uses).
function collectObsLogs() {
  const out = [];
  try {
    for (const name of fs.readdirSync(OBS_LOG_DIR)) {
      if (!name.endsWith('.log') && !name.endsWith('.txt')) continue;
      const abs = path.join(OBS_LOG_DIR, name);
      if (fs.lstatSync(abs).isFile()) out.push({ abs, name });
    }
  } catch {
    // OBS_LOG_DIR missing/unreadable — no OBS logs in this bundle.
  }
  return out;
}

// Build the zip in a private temp dir; caller must delete `dir`. `journalFor`
// is injectable for tests; `extraFiles` maps archive names to string contents.
function createLogsArchive({ journalFor = defaultJournalFor, extraFiles = {} } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oink-logs-'));
  const stage = fs.mkdtempSync(path.join(os.tmpdir(), 'oink-logs-stage-'));
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..+$/, '').replace('T', '-');
  const out = path.join(dir, `oink-logs-${stamp}.zip`);
  let count = 0;
  try {
    const journalDir = path.join(stage, 'journald');
    fs.mkdirSync(journalDir, { recursive: true });
    for (const unit of JOURNAL_UNITS) {
      fs.writeFileSync(path.join(journalDir, `${unit}.log`), journalFor(unit));
      count += 1;
    }

    const obsLogs = collectObsLogs();
    if (obsLogs.length > 0) {
      const obsDir = path.join(stage, 'obs');
      fs.mkdirSync(obsDir, { recursive: true });
      for (const log of obsLogs) {
        fs.copyFileSync(log.abs, path.join(obsDir, log.name));
      }
      count += obsLogs.length;
    }

    for (const [name, contents] of Object.entries(extraFiles)) {
      fs.writeFileSync(path.join(stage, name), contents);
      count += 1;
    }

    fs.writeFileSync(path.join(stage, 'README.txt'), README);
    count += 1;

    execFileSync('zip', ['-q', '-X', '-r', out, '.'], {
      cwd: stage, stdio: 'ignore', timeout: 120000,
    });
  } catch (e) {
    fs.rmSync(dir, { recursive: true, force: true });
    throw new Error(`log bundle failed: ${e.message}`);
  } finally {
    fs.rmSync(stage, { recursive: true, force: true });
  }
  fs.chmodSync(out, 0o600);
  return { file: out, dir, count };
}

module.exports = {
  createLogsArchive,
  collectObsLogs,
  JOURNAL_UNITS,
  JOURNAL_MAX_LINES,
  JOURNAL_SINCE,
};
