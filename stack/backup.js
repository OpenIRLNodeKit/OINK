// SPDX-FileCopyrightText: 2026 OpenIRLNodeKit contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
'use strict';

/**
 * backup.js — dashboard-side backup/restore.
 *
 * The source set lives in stack/backup-set.json (shared with scripts/backup.py),
 * so the CLI and the dashboard can never drift. Archives are `.zip` (user
 * friendly downloads) built/extracted with the system `zip`/`unzip` binaries.
 *
 * Restore treats the uploaded archive as UNTRUSTED:
 *   - every member name is validated against the shared set (no absolute paths,
 *     no `..`, no unknown members) before anything is written;
 *   - each file is streamed out with `unzip -p` and its sha256 checked against
 *     the manifest — we never let `unzip` create symlinks/hardlinks in place;
 *   - entries marked `restore: "cli-only"` (api.env — needs unit restarts the
 *     dashboard user cannot do) are skipped.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFileSync, spawn } = require('child_process');
const { InputError } = require('./errors');

const STACK_DIR = process.env.OINK_STACK_DIR || __dirname;
const OBS_CONFIG_DIR = path.dirname(process.env.OBS_LOG_DIR || '/obs-logs');
const OBS_ASSET_DIR = process.env.OBS_ASSET_DIR || '/obs-assets';
const OBS_RECORDING_DIR = process.env.OBS_RECORDING_DIR || '/obs-recordings';

const SET_FILE = path.join(STACK_DIR, 'backup-set.json');
const MANIFEST_NAME = 'manifest.json';
const FORMAT_VERSION = 1;

function roots() {
  return {
    stack: STACK_DIR,
    obs: OBS_CONFIG_DIR,
    assets: OBS_ASSET_DIR,
    recordings: OBS_RECORDING_DIR,
  };
}

function loadSet() {
  let data;
  try {
    data = JSON.parse(fs.readFileSync(SET_FILE, 'utf-8'));
  } catch (e) {
    throw new InputError(`backup set unreadable (${SET_FILE}): ${e.message}`);
  }
  return Array.isArray(data.entries) ? data.entries : [];
}

function arcOf(entry) {
  return entry.rel ? `${entry.root}/${entry.rel}` : entry.root;
}

// Resolve a member's absolute target path from its arc name.
function targetFor(arc) {
  const root = arc.split('/')[0];
  const base = roots()[root];
  if (!base) throw new InputError(`unknown backup root: ${root}`);
  const rel = arc.slice(root.length + 1);
  return rel ? path.join(base, rel) : base;
}

function sha256File(p) {
  const h = crypto.createHash('sha256');
  h.update(fs.readFileSync(p));
  return h.digest('hex');
}

function walkFiles(absDir, relBase, out) {
  for (const name of fs.readdirSync(absDir)) {
    const abs = path.join(absDir, name);
    const st = fs.lstatSync(abs);
    if (st.isSymbolicLink()) continue;
    const rel = relBase ? `${relBase}/${name}` : name;
    // Skip our own restore safety copies so repeated backups don't grow.
    if (st.isFile()) {
      if (!name.includes('.pre-restore-')) out.push({ abs, rel });
    } else if (st.isDirectory()) {
      walkFiles(abs, rel, out);
    }
  }
}

// Expand the shared set to concrete (abs path, arcname) files.
function collect(opts = {}) {
  const entries = loadSet();
  const files = [];
  const missing = [];
  for (const entry of entries) {
    // Accounts are host identity, not archive content: never transfer them.
    if (entry.backup === false) continue;
    if (entry.toggle && !opts[entry.toggle]) continue;
    const base = roots()[entry.root];
    if (entry.kind === 'file') {
      const abs = path.join(base, entry.rel);
      if (fs.existsSync(abs) && fs.lstatSync(abs).isFile()) {
        files.push({ abs, arc: arcOf(entry), mode: fs.statSync(abs).mode & 0o777 });
      } else {
        missing.push(arcOf(entry));
      }
    } else {
      const absDir = entry.rel ? path.join(base, entry.rel) : base;
      if (!fs.existsSync(absDir) || !fs.statSync(absDir).isDirectory()) {
        missing.push(`${arcOf(entry)}/`);
        continue;
      }
      const found = [];
      walkFiles(absDir, '', found);
      for (const f of found) {
        files.push({
          abs: f.abs,
          arc: `${arcOf(entry)}/${f.rel}`,
          mode: fs.statSync(f.abs).mode & 0o777,
        });
      }
    }
  }
  return { files, missing };
}

function stats(opts = {}) {
  const { files } = collect(opts);
  return {
    files: files.length,
    bytes: files.reduce((n, f) => n + fs.statSync(f.abs).size, 0),
  };
}

function buildManifest(files) {
  return {
    version: FORMAT_VERSION,
    created_at: new Date().toISOString(),
    files: files.map((f) => ({
      path: f.arc,
      sha256: sha256File(f.abs),
      mode: f.mode.toString(8).padStart(4, '0'),
    })),
  };
}

// Safe filename segment: keep it to a conservative charset so a channel name
// can never inject path separators or quotes into the download header.
function slug(raw) {
  return String(raw || '').replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 64);
}

// Create a zip in a private temp dir. Caller must delete `dir`. The archive is
// named for the channel (if set) else just the timestamp — never the hostname.
function createArchive(opts = {}) {
  const { files, missing } = collect(opts);
  if (files.length === 0) throw new InputError('nothing to back up — is this an installed node?');

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oink-backup-'));
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..+$/, '').replace('T', '-');
  const label = slug(opts.channel);
  const out = path.join(
    dir,
    label ? `oink-backup-${label}-${stamp}.zip` : `oink-backup-${stamp}.zip`,
  );
  // Stage a tree with hardlinks (fallback copy across filesystems) so every
  // member carries its exact arc name, including the root prefix.
  const stage = fs.mkdtempSync(path.join(STACK_DIR, '.backup-stage-'));
  try {
    for (const f of files) {
      const dest = path.join(stage, f.arc);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      try {
        fs.linkSync(f.abs, dest);
      } catch {
        fs.copyFileSync(f.abs, dest);
      }
    }
    fs.writeFileSync(
      path.join(stage, MANIFEST_NAME),
      JSON.stringify(buildManifest(files), null, 2),
    );
    const top = [...new Set(files.map((f) => f.arc.split('/')[0]))];
    top.push(MANIFEST_NAME);
    execFileSync('zip', ['-q', '-X', '-D', '-r', out, ...top], {
      cwd: stage, stdio: 'ignore', timeout: 15 * 60 * 1000,
    });
  } catch (e) {
    fs.rmSync(dir, { recursive: true, force: true });
    throw new InputError(`zip failed: ${e.message}`);
  } finally {
    fs.rmSync(stage, { recursive: true, force: true });
  }
  fs.chmodSync(out, 0o600);
  return { file: out, dir, missing, count: files.length };
}

// ── Restore ─────────────────────────────────────────────────────────────────

function isSafeMember(name) {
  if (!name || name.startsWith('/') || name.includes('\\')) return false;
  return name.split('/').every((seg) => seg !== '' && seg !== '.' && seg !== '..');
}

// Validate every archive member against the shared set. Returns the allowed
// list; throws on anything unexpected (traversal, unknown path).
function validateMembers(names) {
  const entries = loadSet();
  const rootsAllowed = new Set(entries.map((e) => e.root));
  const fileArcs = new Set(entries.filter((e) => e.kind === 'file').map(arcOf));
  const dirArcs = entries.filter((e) => e.kind === 'dir').map(arcOf);
  const allowed = [];
  for (const raw of names) {
    const name = raw.replace(/\/+$/, '');
    if (!name || name === '.') continue;
    if (raw.startsWith('-')) throw new InputError(`unsafe archive member: ${raw}`);
    if (name === MANIFEST_NAME) continue; // read separately
    if (!isSafeMember(name)) throw new InputError(`unsafe archive member: ${raw}`);
    const root = name.split('/')[0];
    if (!rootsAllowed.has(root)) throw new InputError(`archive member outside the backup set: ${raw}`);
    const ok = fileArcs.has(name) || dirArcs.some((d) => name.startsWith(`${d}/`));
    if (!ok) throw new InputError(`archive member outside the backup set: ${raw}`);
    allowed.push(name);
  }
  return allowed;
}

function readManifest(archive) {
  let text;
  try {
    text = execFileSync('unzip', ['-p', archive, MANIFEST_NAME], {
      encoding: 'utf-8', maxBuffer: 8 * 1024 * 1024, timeout: 60 * 1000,
    });
  } catch {
    throw new InputError('archive is missing a readable manifest.json');
  }
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new InputError('archive manifest.json is not valid JSON');
  }
  if (!data || data.version !== FORMAT_VERSION || !Array.isArray(data.files)) {
    throw new InputError(`unsupported backup format: ${data && data.version}`);
  }
  return data;
}

function listMembers(archive) {
  const out = execFileSync('unzip', ['-Z1', archive], {
    encoding: 'utf-8', maxBuffer: 64 * 1024 * 1024, timeout: 5 * 60 * 1000,
  });
  return out.split('\n').filter((l) => l.trim() !== '');
}

// Stream one member out of the zip to `dest`, hashing as it goes. `unzip -p`
// only emits the stored bytes, so symlink members can never be materialised.
function extractToFile(archive, member, dest, expectedSha) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    let size = 0;
    let done = false;
    const finish = (fn, arg) => {
      if (!done) {
        done = true;
        fn(arg);
      }
    };
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    const out = fs.createWriteStream(dest, { mode: 0o600 });
    const child = spawn('unzip', ['-p', archive, member], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (d) => { stderr += d.toString(); });
    child.stdout.on('data', (d) => { size += d.length; hash.update(d); });
    child.stdout.pipe(out);
    child.on('error', (e) => finish(reject, e));
    out.on('error', (e) => finish(reject, e));
    child.on('close', (code) => {
      out.end(() => {
        if (code !== 0) {
          return finish(reject, new InputError(`unzip failed for ${member}: ${stderr.trim()}`));
        }
        if (expectedSha && hash.digest('hex') !== expectedSha) {
          return finish(reject, new InputError(`checksum mismatch: ${member}`));
        }
        finish(resolve, size);
      });
    });
  });
}

// Inspect an archive's manifest without extracting: which services its restore
// affects.
function inspectArchive(archive) {
  const arcs = readManifest(archive).files.map((f) => f.path);
  return {
    touched: {
      obs: arcs.some((a) => a.startsWith('obs/')),
      mediamtx: arcs.includes('stack/mediamtx.yml'),
      noalbs: arcs.some((a) => a.startsWith('stack/noalbs/')),
    },
  };
}

// A backup carries the source box's ingest address in restored OBS scene
// configs (irl_source settings.url). Re-point OINK SRT read URLs at loopback so
// the restored scene still pulls from *this* box's MediaMTX. Other SRT URLs
// (external feeds, other ports) are left alone.
const SRT_INGEST_RE = /^srt:\/\/[^/?#]+:8890(?=[/?#]|$)/i;

function localizeIngestUrls(value) {
  if (typeof value === 'string') {
    return value.replace(SRT_INGEST_RE, 'srt://127.0.0.1:8890');
  }
  if (Array.isArray(value)) return value.map(localizeIngestUrls);
  if (value && typeof value === 'object') {
    for (const key of Object.keys(value)) value[key] = localizeIngestUrls(value[key]);
  }
  return value;
}

function localizeSceneFile(dest) {
  try {
    const data = JSON.parse(fs.readFileSync(dest, 'utf-8'));
    fs.writeFileSync(dest, JSON.stringify(localizeIngestUrls(data)));
  } catch {
    // Not scene JSON / unreadable: keep the restored bytes as-is.
  }
}

function writeInto(src, dest, meta) {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(src, dest);
  if (meta.mode) fs.chmodSync(dest, parseInt(meta.mode, 8));
}

// The restored NOALBS config carries the source box's OBS websocket password,
// which never matches this install's OBS. Re-assert the local one so restored
// stream control still authenticates. Missing file/password: leave it alone.
function syncObsPassword(dest) {
  try {
    const pw = fs.readFileSync(
      path.join(OBS_CONFIG_DIR, 'plugin_config/obs-websocket/password'), 'utf-8',
    ).trim();
    if (!pw) return;
    const data = JSON.parse(fs.readFileSync(dest, 'utf-8'));
    if (!data || !data.software || typeof data.software !== 'object') return;
    if (data.software.password === pw) return;
    data.software.password = pw;
    fs.writeFileSync(dest, JSON.stringify(data, null, 2) + '\n', { mode: 0o600 });
  } catch {
    // Best effort: keep the restored config rather than failing the restore.
  }
}

/**
 * Restore an uploaded archive. Returns { restored, skipped, failed, touched }
 * where `touched` lists `{stack, obs}` roots that changed (caller restarts units).
 */
async function restoreArchive(archive) {
  const manifest = readManifest(archive);
  const modeByPath = new Map(manifest.files.map((f) => [f.path, f]));
  const cliOnly = new Set(
    loadSet().filter((e) => e.restore === 'cli-only').map(arcOf),
  );
  const keepCurrent = new Set(
    loadSet().filter((e) => e.backup === false).map(arcOf),
  );

  const names = listMembers(archive);
  const allowed = validateMembers(names);
  const nameSet = new Set(names);
  for (const arc of modeByPath.keys()) {
    if (!nameSet.has(arc)) throw new InputError(`archive is missing ${arc}`);
  }

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'oink-restore-'));
  const restored = [];
  const skipped = [];
  const failed = [];
  const touched = { stack: false, obs: false };
  const mark = (root) => {
    if (root === 'stack') touched.stack = true;
    if (root === 'obs') touched.obs = true;
  };
  try {
    for (const arc of allowed) {
      const meta = modeByPath.get(arc);
      if (!meta) continue; // directory member
      // Legacy archives still carry accounts; restoring them would replace this
      // install's credentials, so keep the current file.
      if (keepCurrent.has(arc)) {
        skipped.push(arc);
        continue;
      }
      const root = arc.split('/')[0];
      if (cliOnly.has(arc)) {
        skipped.push(arc);
        continue;
      }
      const dest = targetFor(arc);
      const staged = path.join(tmp, arc);
      try {
        await extractToFile(archive, arc, staged, meta.sha256);
        writeInto(staged, dest, meta);
        if (arc === 'stack/noalbs/config.json') syncObsPassword(dest);
        if (arc.startsWith('obs/basic/scenes/') && arc.endsWith('.json')) {
          localizeSceneFile(dest);
        }
        restored.push(arc);
        mark(root);
      } catch (e) {
        // A root-owned leftover (e.g. oink-pin-recordings.sh runs as root) can
        // block the obsuser control plane from overwriting. The parent dir is
        // ours, so unlink and recreate rather than failing the whole restore.
        try {
          fs.rmSync(dest, { force: true });
          writeInto(staged, dest, meta);
          restored.push(arc);
          mark(root);
        } catch (e2) {
          failed.push({ path: arc, error: e2.message });
        }
      } finally {
        fs.rmSync(staged, { force: true });
      }
    }
    return { restored, skipped, failed, touched };
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

module.exports = {
  stats,
  createArchive,
  inspectArchive,
  restoreArchive,
  validateMembers,
};
