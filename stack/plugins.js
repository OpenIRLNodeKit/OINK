'use strict';
// SPDX-FileCopyrightText: 2026 OpenIRLNodeKit contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

// OBS drop-in plugin manager for the OINK control-plane.
//
// Owns the pinned default-plugin manifest, on-disk install/remove detection,
// load probing, and the download/verify/extract of a plugin archive or .deb.
// It relies on obs-bridge only for the obs-websocket input-kind probe.

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { execFile, execFileSync } = require('child_process');
const { InputError } = require('./errors');
const { obsEnqueue, _obsHasInputKind } = require('./obs-bridge');

const STACK_DIR = process.env.OINK_STACK_DIR || __dirname;
const OBS_LOG_DIR = process.env.OBS_LOG_DIR || '/obs-logs';
// OBS scans ~/.config/obs-studio/plugins/<name>/{bin/64bit/*.so,data} for
// per-user plugins; the config dir is the parent of the OBS log dir.
const OBS_PLUGIN_DIR = path.join(path.dirname(OBS_LOG_DIR), 'plugins');

// Upper bound for a single uploaded plugin archive.
const PLUGIN_UPLOAD_MAX_BYTES = 100 * 1024 * 1024;

// Default plugins shipped by the build (installed by oink.py §4c/§4d and
// reinstallable from this dashboard). Pinned release metadata (url, sha256,
// packaging kind, min OBS) lives in components.json next to this file —
// the SAME file the oink.py setup reads. `probe` names an obs-websocket input
// kind to prove the plugin loaded (only obs-irl-source registers one).
const DEFAULT_PLUGINS = (() => {
  const defaultsPath = path.join(STACK_DIR, 'components.json');
  try {
    const raw = JSON.parse(
      fs.readFileSync(defaultsPath, 'utf8'),
    );
    return (raw.plugins || []).map((p) => ({
      name: p.name,
      version: p.version,
      url: p.url,
      sha256: p.sha256,
      kind: p.kind || 'tar',
      minObs: p.min_obs || [0, 0],
      probe: p.name === 'obs-irl-source' ? 'irl_source' : null,
    }));
  } catch (e) {
    console.error(
      `[WARN] Could not load default plugin registry (${defaultsPath}): ${e.message}` +
      ' — plugin status/install endpoints will return empty; set OINK_DEFAULT_PLUGINS_FILE to override.',
    );
    return [];
  }
})();
const DEFAULT_PLUGIN_NAMES = new Set(DEFAULT_PLUGINS.map((p) => p.name));

function defaultPlugin(name) {
  return DEFAULT_PLUGINS.find((p) => p.name === name) || null;
}

function findPluginSo(dir) {
  if (!fs.existsSync(dir)) return null;
  const stack = [dir];
  while (stack.length) {
    const cur = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(cur, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const ent of entries) {
      const p = path.join(cur, ent.name);
      if (ent.isDirectory()) stack.push(p);
      else if (ent.isFile() && p.endsWith('.so')) return p;
    }
  }
  return null;
}

function pluginInstalled(name) {
  return !!findPluginSo(path.join(OBS_PLUGIN_DIR, name));
}

// True when the oink-obs systemd unit is currently active.
function obsUnitActive() {
  try {
    return execFileSync('systemctl', ['is-active', 'oink-obs'], { encoding: 'utf-8' })
      .trim() === 'active';
  } catch {
    return false;
  }
}

// oink-obs's ActiveEnterTimestampUSec as epoch milliseconds, or null.
function obsUnitStartMs() {
  try {
    const out = execFileSync(
      'systemctl', ['show', '-p', 'ActiveEnterTimestampUSec', 'oink-obs'],
      { encoding: 'utf-8' },
    ).trim();
    const m = /ActiveEnterTimestampUSec=(\d+)/.exec(out);
    return m ? Number(m[1]) / 1000 : null;
  } catch {
    return null;
  }
}

// True when a plugin is actually loaded in OBS (not just present on disk).
async function pluginLoaded(meta) {
  if (!pluginInstalled(meta.name)) return false;
  if (meta.probe) {
    try {
      return await obsEnqueue(() => _obsHasInputKind(meta.probe));
    } catch {
      return false; // OBS down/restarting — treat as not loaded
    }
  }
  if (!obsUnitActive()) return false;
  const so = findPluginSo(path.join(OBS_PLUGIN_DIR, meta.name));
  if (!so) return false;
  const start = obsUnitStartMs();
  if (start === null) return true;
  try {
    return fs.statSync(so).mtimeMs <= start;
  } catch {
    return true;
  }
}

function _sha256File(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function _downloadFile(url, dest) {
  return new Promise((resolve, reject) => {
    execFile(
      'curl',
      ['-fsSL', '--max-time', '180', '-o', dest, url],
      { maxBuffer: 1024 * 1024 },
      (err) => (err ? reject(err) : resolve()),
    );
  });
}

// Verify a tarball's entries stay inside the stage dir (zip-slip guard), then
// extract it and install the single plugin it carries into OBS_PLUGIN_DIR.
function _installPluginArchive(tarFile, forcedName, { allowDefault = false } = {}) {
  const stage = fs.mkdtempSync(path.join(OBS_PLUGIN_DIR, '.stage-'));
  try {
    let entries;
    try {
      entries = execFileSync('tar', ['-tf', tarFile], {
        encoding: 'utf-8',
        maxBuffer: 64 * 1024 * 1024,
      })
        .split('\n')
        .filter(Boolean);
    } catch {
      throw new InputError('Could not read the archive — is it a .tar.gz/.tar.xz/.tar.bz2?');
    }
    for (const raw of entries) {
      const rel = raw.replace(/\/+$/, '');
      if (!rel) continue;
      if (path.isAbsolute(rel) || rel.split(/[\\/]/).includes('..')) {
        throw new InputError('Archive contains an unsafe path');
      }
    }

    execFileSync('tar', ['-xf', tarFile, '-C', stage], { stdio: 'ignore' });

    const so = forcedName
      ? findPluginSo(path.join(stage, forcedName)) || findFileNamed(stage, `${forcedName}.so`)
      : findPluginSo(stage);
    if (!so) {
      throw new InputError('No OBS plugin binary (bin/64bit/*.so) found in the archive');
    }

    const topRoot = path.dirname(path.dirname(path.dirname(so)));
    if (!forcedName) {
      const seg = path.relative(stage, so).split(path.sep);
      if (seg.length < 3 || seg[1] !== 'bin' || seg[2] !== '64bit') {
        throw new InputError('Unexpected plugin layout in the archive');
      }
    }
    const name = forcedName || path.basename(topRoot);

    const dest = path.join(OBS_PLUGIN_DIR, name);
    fs.mkdirSync(OBS_PLUGIN_DIR, { recursive: true });
    if (!allowDefault && DEFAULT_PLUGIN_NAMES.has(name)) {
      throw new InputError(
        `${name} is a default plugin of the build — use its pinned installer`,
      );
    }
    fs.rmSync(dest, { recursive: true, force: true });
    fs.renameSync(topRoot, dest);
    return { name, so: findPluginSo(dest), dir: dest };
  } finally {
    fs.rmSync(stage, { recursive: true, force: true });
  }
}

// Deep-search for the first file with the given basename.
function findFileNamed(dir, fileName) {
  if (!fs.existsSync(dir)) return null;
  const stack = [dir];
  while (stack.length) {
    const cur = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(cur, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const ent of entries) {
      const p = path.join(cur, ent.name);
      if (ent.isDirectory()) stack.push(p);
      else if (ent.isFile() && ent.name === fileName) return p;
    }
  }
  return null;
}

// Extract a plugin .deb into the per-user plugins dir.
function _installPluginDeb(debFile, name) {
  const stage = fs.mkdtempSync(path.join(OBS_PLUGIN_DIR, '.stage-'));
  try {
    execFileSync('dpkg-deb', ['-x', debFile, stage], { stdio: 'ignore' });
    let so = null;
    const libRoot = path.join(stage, 'usr', 'lib');
    const walk = (dir) => {
      let entries;
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const ent of entries) {
        if (so) return;
        const p = path.join(dir, ent.name);
        if (ent.isDirectory()) walk(p);
        else if (ent.isFile() && ent.name === `${name}.so`) so = p;
      }
    };
    if (fs.existsSync(libRoot)) walk(libRoot);
    if (!so) throw new InputError(`No ${name}.so found in the .deb`);

    const dest = path.join(OBS_PLUGIN_DIR, name);
    fs.rmSync(dest, { recursive: true, force: true });
    fs.mkdirSync(path.join(dest, 'bin', '64bit'), { recursive: true });
    fs.copyFileSync(so, path.join(dest, 'bin', '64bit', `${name}.so`));

    const share = path.join(stage, 'usr', 'share', 'obs', 'obs-plugins', name);
    if (fs.existsSync(share)) {
      fs.mkdirSync(path.join(dest, 'data'), { recursive: true });
      for (const ent of fs.readdirSync(share)) {
        fs.cpSync(path.join(share, ent), path.join(dest, 'data', ent), { recursive: true });
      }
    }
    return { name, so: findPluginSo(dest), dir: dest };
  } finally {
    fs.rmSync(stage, { recursive: true, force: true });
  }
}

module.exports = {
  OBS_PLUGIN_DIR,
  PLUGIN_UPLOAD_MAX_BYTES,
  DEFAULT_PLUGINS,
  DEFAULT_PLUGIN_NAMES,
  defaultPlugin,
  findPluginSo,
  findFileNamed,
  pluginInstalled,
  pluginLoaded,
  _downloadFile,
  _sha256File,
  _installPluginArchive,
  _installPluginDeb,
};
