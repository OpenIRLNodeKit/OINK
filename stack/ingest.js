// SPDX-FileCopyrightText: 2026 OpenIRLNodeKit contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * ingest.js — per-install ingest stream key management.
 *
 * Security model: publishing/reading on MediaMTX is allowed ONLY on paths under
 * the keyed namespace `live/<key>/` (the mediamtx.yml auth grant + path entries
 * are scoped to `~^live/<key>/`). The secret key lives in ~/oink/stack/ingest.json
 * (0600). Rotation rewrites the installed mediamtx.yml and the NOALBS statsUrl to
 * point at the new namespace, then the caller restarts oink-mediamtx.
 *
 * Pure + requireable (no HTTP, no side effects beyond the files it owns), so it
 * can be unit-tested with node:test.
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const INGEST_FILE = 'ingest.json';
const NAMESPACE_TEMPLATE = 'live/{key}/{label}';

function canonicalPath(key, label) {
  return NAMESPACE_TEMPLATE.replace('{key}', key).replace('{label}', label);
}

function namespacePrefix(key) {
  return `live/${key}/`;
}

function isValidKey(key) {
  // token_urlsafe output: A-Z a-z 0-9 - _ ; reject anything else so the value
  // is safe to embed in a URL path and a MediaMTX regex.
  return typeof key === 'string' && /^[A-Za-z0-9_-]{20,}$/.test(key);
}

function generateKey() {
  return crypto.randomBytes(18).toString('base64url'); // 24 chars
}

function ingestFilePath(stackDir) {
  return path.join(stackDir, INGEST_FILE);
}

function readState(stackDir) {
  const p = ingestFilePath(stackDir);
  try {
    const data = JSON.parse(fs.readFileSync(p, 'utf8'));
    if (data && isValidKey(data.key)) return data;
  } catch {
    // fall through to null
  }
  return null;
}

function ensureState(stackDir, seedKey) {
  const p = ingestFilePath(stackDir);
  const existing = readState(stackDir);
  if (existing) return existing;
  const now = Date.now();
  const state = {
    version: 1,
    key: isValidKey(seedKey) ? seedKey : generateKey(),
    createdAt: now,
    updatedAt: now,
  };
  fs.mkdirSync(stackDir, { recursive: true });
  const tmp = `${p}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2) + '\n');
  fs.chmodSync(tmp, 0o600);
  fs.renameSync(tmp, p);
  return state;
}

function writeState(stackDir, state) {
  state.updatedAt = Date.now();
  const p = ingestFilePath(stackDir);
  const tmp = `${p}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2) + '\n');
  fs.chmodSync(tmp, 0o600);
  fs.renameSync(tmp, p);
}

function mediamtxPath(stackDir) {
  return path.join(stackDir, 'mediamtx.yml');
}

function noalbsPath(stackDir) {
  return path.join(stackDir, 'noalbs', 'config.json');
}

// The reserved "main" ingest label (also the default monitored feed for NOALBS).
// It is statically declared in mediamtx.yml and cannot be deleted from the
// profile list. Renamed from the historic `stream` convention.
const RESERVED_LABEL = 'irl';

function noalbsStatsUrl(key, label = RESERVED_LABEL) {
  return `http://127.0.0.1:9997/v3/paths/get/${canonicalPath(key, label)}`;
}

/**
 * Bootstrap a fresh install: ensure the stream key, then render the installed
 * mediamtx.yml from the repo template (the `__STREAM_KEY__` placeholder) so the
 * keyed namespace is live before oink-mediamtx starts. Returns the state.
 * Rotation keeps the in-place token rewrite (applyStreamKey) instead — this is
 * only the setup-time fresh render.
 */
function bootstrap(stackDir, templateFile, seedKey) {
  const state = ensureState(stackDir, seedKey);
  let template;
  try {
    template = fs.readFileSync(templateFile, 'utf8');
  } catch {
    throw new Error(`mediamtx template not found: ${templateFile}`);
  }
  const rendered = template.split('__STREAM_KEY__').join(state.key);
  if (rendered.includes('__STREAM_KEY__')) {
    throw new Error('failed to substitute __STREAM_KEY__ in mediamtx template');
  }
  fs.writeFileSync(mediamtxPath(stackDir), rendered, 'utf8');
  return state;
}

/**
 * Rewrite the installed mediamtx.yml + NOALBS config from an old stream key to a
 * new one. Token-scoped textual replacement preserves any operator edits and
 * comments; only the keyed namespace tokens change.
 *
 * Returns { changed: <string[]> } listing which files changed, or throws with a
 * descriptive message if the installed configs do not carry the old key (i.e.
 * they were manually diverged and rotation cannot be applied safely).
 */
function applyStreamKey(stackDir, newKey) {
  if (!isValidKey(newKey)) {
    throw new Error('stream key must be 20+ chars of [A-Za-z0-9_-]');
  }

  const state = ensureState(stackDir);
  const oldKey = state.key;
  if (oldKey === newKey) {
    return { changed: [] };
  }

  const oldPrefix = namespacePrefix(oldKey);
  const newPrefix = namespacePrefix(newKey);
  const changed = [];

  // mediamtx.yml
  const mtxFile = mediamtxPath(stackDir);
  let mtx = null;
  try {
    mtx = fs.readFileSync(mtxFile, 'utf8');
  } catch {
    throw new Error('mediamtx.yml not found under the stack dir');
  }
  if (!mtx.includes(oldPrefix)) {
    throw new Error(
      `mediamtx.yml does not reference the keyed namespace ${oldPrefix}; ` +
        'it was edited outside rotation — fix it manually or re-run oink setup',
    );
  }
  // Replace old→new; guard against partial / double application by asserting the
  // new prefix appears and the old one is gone afterwards.
  mtx = mtx.split(oldPrefix).join(newPrefix);
  if (mtx.includes(oldPrefix)) {
    throw new Error('failed to rewrite mediamtx.yml stream-key namespace');
  }
  if (!mtx.includes(newPrefix)) {
    throw new Error('failed to apply new stream-key namespace to mediamtx.yml');
  }
  if (fs.existsSync(mtxFile)) fs.copyFileSync(mtxFile, `${mtxFile}.bak`);
  fs.writeFileSync(mtxFile, mtx, 'utf8');
  changed.push('mediamtx.yml');

  // noalbs/config.json statsUrl
  const noalbsFile = noalbsPath(stackDir);
  if (fs.existsSync(noalbsFile)) {
    let noalbs = fs.readFileSync(noalbsFile, 'utf8');
    if (noalbs.includes(oldPrefix)) {
      noalbs = noalbs.split(oldPrefix).join(newPrefix);
      fs.writeFileSync(noalbsFile, noalbs, 'utf8');
      changed.push('noalbs/config.json');
    }
  }

  const next = { ...state, key: newKey, updatedAt: Date.now() };
  writeState(stackDir, next);
  return { changed };
}

// ── Ingest profiles + monitored (main) feed ───────────────────────────────────
// The operator's named feeds (the "Stream Name" saved on the Ingest page). Each
// becomes the `<label>` of `live/<key>/<label>` and shows up as a selectable
// feed on the dashboard. Stored server-side so every browser/operator sees the
// same list. The label is embedded in MediaMTX paths/URLs/deep links, so the
// charset is restricted rather than free text.
//
// One feed is *monitored* at a time (the one NOALBS's auto-switcher follows).
// The reserved `irl` label is always present, non-deletable, and is the default
// monitored feed until the operator promotes another profile.

const PROFILES_FILE = 'profiles.json';
const PROFILE_RE = /^[A-Za-z0-9._-]{1,64}$/;
const MAX_PROFILES = 50;

// The default profile state: the reserved label present, monitored = `irl`.
function defaultProfileState() {
  return { profiles: [RESERVED_LABEL], main: RESERVED_LABEL };
}

function profilesPath(stackDir) {
  return path.join(stackDir, PROFILES_FILE);
}

// Validate a raw profile list. Returns the cleaned list (trimmed, de-duped,
// order preserved) or throws a descriptive Error.
function normalizeProfiles(input) {
  if (!Array.isArray(input))
    throw new Error('profiles must be an array of strings');
  if (input.length > MAX_PROFILES)
    throw new Error(`too many profiles (max ${MAX_PROFILES})`);
  const seen = new Set();
  const out = [];
  for (const raw of input) {
    if (typeof raw !== 'string')
      throw new Error('each profile must be a string');
    const name = raw.trim();
    if (!PROFILE_RE.test(name)) {
      throw new Error(
        `invalid profile "${name}": use 1–64 chars of letters, digits, dot, dash or underscore`,
      );
    }
    if (seen.has(name)) continue;
    seen.add(name);
    out.push(name);
  }
  return out;
}

// Normalize { profiles, main }: the reserved `irl` is always present (cannot be
// deleted) and `main` always resolves to a real profile (default `irl`).
function normalizeProfileState(input) {
  const raw =
    input && typeof input === 'object' && !Array.isArray(input)
      ? input
      : { profiles: Array.isArray(input) ? input : [] };
  const profiles = normalizeProfiles(raw.profiles);
  if (!profiles.includes(RESERVED_LABEL)) profiles.unshift(RESERVED_LABEL);
  const main =
    typeof raw.main === 'string' && profiles.includes(raw.main)
      ? raw.main
      : RESERVED_LABEL;
  return { profiles, main };
}

// Best-effort read: absent/corrupt file yields the default state.
function readProfileState(stackDir) {
  try {
    const data = JSON.parse(fs.readFileSync(profilesPath(stackDir), 'utf8'));
    if (Array.isArray(data)) return normalizeProfileState({ profiles: data });
    return normalizeProfileState(data || {});
  } catch {
    return defaultProfileState();
  }
}

function writeProfileState(stackDir, input) {
  const state = normalizeProfileState(input);
  const file = profilesPath(stackDir);
  const tmp = `${file}.tmp`;
  fs.writeFileSync(
    tmp,
    JSON.stringify(
      { version: 1, profiles: state.profiles, main: state.main, updatedAt: Date.now() },
      null,
      2,
    ) + '\n',
  );
  fs.chmodSync(tmp, 0o600);
  fs.renameSync(tmp, file);
  return state;
}

// Re-point the installed NOALBS config's Mediamtx streamServer at the given
// label. Returns true when the file actually changed (callers restart
// oink-noalbs only then, and only while it is running).
function setNoalbsMain(stackDir, label) {
  if (!PROFILE_RE.test(String(label || '')))
    throw new Error(`invalid monitored label "${label}"`);
  const file = noalbsPath(stackDir);
  let data;
  try {
    data = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return false;
  }
  let changed = false;
  for (const server of (data.switcher && data.switcher.streamServers) || []) {
    const stats = server.streamServer;
    const url = stats && typeof stats.statsUrl === 'string'
      ? stats.statsUrl
      : '';
    if (!url.includes('/v3/paths/get/live/')) continue;
    const next = url.replace(/(\/v3\/paths\/get\/live\/[^/]+\/)[^/]+$/, `$1${label}`);
    if (next !== url) {
      stats.statsUrl = next;
      changed = true;
    }
    break;
  }
  if (changed) {
    fs.writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`);
  }
  return changed;
}

module.exports = {
  INGEST_FILE,
  PROFILES_FILE,
  RESERVED_LABEL,
  canonicalPath,
  namespacePrefix,
  isValidKey,
  generateKey,
  readState,
  ensureState,
  bootstrap,
  mediamtxPath,
  noalbsPath,
  noalbsStatsUrl,
  applyStreamKey,
  normalizeProfiles,
  normalizeProfileState,
  readProfileState,
  writeProfileState,
  setNoalbsMain,
};

// CLI: `node ingest.js bootstrap <stackDir> <mediamtxTemplate>` — prints the
// resulting state as JSON on stdout (setup-time delegation from stack.py).
if (require.main === module) {
  const [, , command, stackDir, templateFile, seedKey] = process.argv;
  if (command === 'bootstrap' && stackDir && templateFile) {
    try {
      console.log(JSON.stringify(bootstrap(stackDir, templateFile, seedKey)));
    } catch (e) {
      console.error(`[ingest] bootstrap failed: ${e.message}`);
      process.exit(1);
    }
  } else {
    console.error(
      'usage: node ingest.js bootstrap <stackDir> <mediamtxTemplate> [seedKey]',
    );
    process.exit(2);
  }
}
