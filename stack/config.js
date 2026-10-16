'use strict';
// SPDX-FileCopyrightText: 2026 OpenIRLNodeKit contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

// Config read/write validation + secret redaction for the control-plane's
// /api/config/* endpoints.
//
// The dashboard editor round-trips the whole file, so secrets can't simply be
// stripped on read (a save would clobber them). Instead we replace secret
// values with a placeholder on GET (so they never leave the server) and restore
// the real value from the on-disk file on PUT only when the incoming value is
// still the placeholder.

const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');
const ingest = require('./ingest');

const STACK_DIR = process.env.OINK_STACK_DIR || __dirname;

const CONFIG_FILES = {
  noalbs: path.join(STACK_DIR, 'noalbs', 'config.json'),
  noalbs_env: path.join(STACK_DIR, 'noalbs', '.env'),
  mediamtx: path.join(STACK_DIR, 'mediamtx.yml'),
};

// Placeholder used in place of a real secret on the read path.
const REDACTED = '<redacted>';

// Keys whose values are treated as secrets; both exact and any-key match.
const SECRET_KEYS = new Set(['password', 'stream_key', 'streamkey', 'secret', 'token', 'key', 'apikey']);

function _isSecretKey(key) {
  const k = String(key || '').toLowerCase();
  return SECRET_KEYS.has(k) || k.endsWith('_key') || k.endsWith('password') || k.endsWith('secret');
}

function _redactObject(node) {
  if (Array.isArray(node)) {
    for (const v of node) _redactObject(v);
    return;
  }
  if (!node || typeof node !== 'object') return;
  for (const [k, v] of Object.entries(node)) {
    if (_isSecretKey(k) && typeof v === 'string') {
      if (v !== '' && v !== REDACTED) node[k] = REDACTED;
    } else {
      _redactObject(v);
    }
  }
}

function _restoreSecretsFrom(node, disk) {
  if (Array.isArray(node) && Array.isArray(disk)) {
    for (let i = 0; i < node.length; i += 1) {
      if (i < disk.length) _restoreSecretsFrom(node[i], disk[i]);
    }
    return;
  }
  if (!node || typeof node !== 'object') return;
  const src = disk && typeof disk === 'object' ? disk : {};
  for (const [k, v] of Object.entries(node)) {
    if (_isSecretKey(k) && v === REDACTED && typeof src[k] === 'string') {
      node[k] = src[k];
    } else if (v && typeof v === 'object') {
      _restoreSecretsFrom(v, src[k]);
    }
  }
}

function _mediamtxKey() {
  const state = ingest.readState(STACK_DIR);
  return state && state.key ? state.key : null;
}

// .env vars whose values are secrets; masked on read / restored on write.
const ENV_SECRET_KEYS = new Set(['TWITCH_BOT_OAUTH']);
const ENV_LINE = /^(\s*)([A-Za-z_][A-Za-z0-9_]*)(\s*=\s*)(.*)$/;

function validateConfig(service, content) {
  if (service === 'noalbs') {
    const parsed = JSON.parse(content);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw new Error('config.json must be a JSON object');
    }
    return;
  }
  if (service === 'noalbs_env') {
    for (const line of content.split('\n')) {
      const t = line.trim();
      if (!t || t.startsWith('#')) continue;
      if (!ENV_LINE.test(line)) throw new Error('.env line is not KEY=VALUE: ' + t);
    }
    return;
  }
  if (service === 'mediamtx') {
    try {
      yaml.load(content);
    } catch (e) {
      throw new Error('mediamtx.yml is not valid YAML: ' + e.message);
    }
    return;
  }
}

// Strip secret values from a config for display. Returns the same content shape
// (JSON re-serialized for noalbs; YAML text with the ingest key token replaced
// for mediamtx) so the editor sees a faithful-but-redacted file.
function redactConfig(service, content) {
  if (service === 'noalbs') {
    const parsed = JSON.parse(content);
    _redactObject(parsed);
    return JSON.stringify(parsed, null, 2) + '\n';
  }
  if (service === 'mediamtx') {
    const key = _mediamtxKey();
    if (key) return content.split(key).join(REDACTED);
    return content;
  }
  if (service === 'noalbs_env') {
    return content
      .split('\n')
      .map((line) => {
        const m = line.match(ENV_LINE);
        if (m && ENV_SECRET_KEYS.has(m[2]) && m[4] && m[4] !== REDACTED) {
          return m[1] + m[2] + m[3] + REDACTED;
        }
        return line;
      })
      .join('\n');
  }
  return content;
}

// Before writing a user-supplied config, replace any REDACTED placeholder with
// the real value from the on-disk file so an edit that doesn't touch a secret
// never clobbers it with the placeholder.
function restoreConfigSecrets(service, content) {
  if (service === 'noalbs') {
    const parsed = JSON.parse(content);
    let disk = null;
    try {
      disk = JSON.parse(fs.readFileSync(CONFIG_FILES.noalbs, 'utf-8'));
    } catch {
      disk = null;
    }
    if (disk) _restoreSecretsFrom(parsed, disk);
    return JSON.stringify(parsed, null, 2) + '\n';
  }
  if (service === 'mediamtx') {
    const key = _mediamtxKey();
    if (key) return content.split(REDACTED).join(key);
    return content;
  }
  if (service === 'noalbs_env') {
    // Restore a masked secret from the on-disk .env so an edit elsewhere never
    // writes the placeholder. A missing file leaves the placeholder untouched
    // (nothing to restore from) — the caller only reaches here after a real edit.
    let disk = '';
    try {
      disk = fs.readFileSync(CONFIG_FILES.noalbs_env, 'utf-8');
    } catch {
      disk = '';
    }
    const diskVals = {};
    for (const line of disk.split('\n')) {
      const m = line.match(ENV_LINE);
      if (m) diskVals[m[2]] = m[4];
    }
    return content
      .split('\n')
      .map((line) => {
        const m = line.match(ENV_LINE);
        if (
          m && ENV_SECRET_KEYS.has(m[2]) && m[4] === REDACTED &&
          diskVals[m[2]] !== undefined && diskVals[m[2]] !== ''
        ) {
          return m[1] + m[2] + m[3] + diskVals[m[2]];
        }
        return line;
      })
      .join('\n');
  }
  return content;
}

// Point NOALBS' chat config at `channel` — the Twitch channel NOALBS joins and
// listens in (distinct from the bot login in .env). Returns true when the file
// changed; false on an empty name, missing file, or an unchanged value.
function setNoalbsChannel(channel, file = CONFIG_FILES.noalbs) {
  const name = String(channel || '').trim();
  if (!name) return false;
  let data;
  try {
    data = JSON.parse(fs.readFileSync(file, 'utf-8'));
  } catch {
    return false;
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) return false;
  if (!data.chat || typeof data.chat !== 'object') data.chat = {};
  if (data.chat.username === name) return false;
  data.chat.username = name;
  fs.writeFileSync(file, JSON.stringify(data, null, 2) + '\n', { mode: 0o600 });
  return true;
}

// Force chat.username to `channel` in a noalbs config JSON string. The channel
// is dashboard-owned (settings.js), so a config save must never revert it — the
// editor round-trips the whole file and would otherwise write back a stale
// username. Returns the content unchanged when the channel is empty or the
// content isn't a JSON object.
function pinNoalbsChannel(content, channel) {
  const name = String(channel || '').trim();
  if (!name) return content;
  let data;
  try {
    data = JSON.parse(content);
  } catch {
    return content;
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) return content;
  if (!data.chat || typeof data.chat !== 'object') data.chat = {};
  data.chat.username = name;
  return JSON.stringify(data, null, 2) + '\n';
}

module.exports = {
  CONFIG_FILES,
  REDACTED,
  validateConfig,
  redactConfig,
  restoreConfigSecrets,
  setNoalbsChannel,
  pinNoalbsChannel,
};
