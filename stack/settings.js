// SPDX-FileCopyrightText: 2026 OpenIRLNodeKit contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
'use strict';
/**
 * settings.js — the dashboard's mutable install settings.
 *
 * Owns ~/oink/stack/dashboard.json (0600, atomic writes): the Twitch channel
 * name and whether the first-run welcome screen is done. Seeded once from the
 * OINK_* env the installer provisioned (OINK_TWITCH_CHANNEL), then owned by the
 * dashboard — a re-run of setup does not clobber an edited value.
 *
 * Pure + requireable (no HTTP), so it can be unit-tested with node:test.
 */

const fs = require('fs');
const path = require('path');

const SETTINGS_FILE = 'dashboard.json';

// Twitch usernames: letters, digits, underscore, up to 25 chars.
const CHANNEL_RE = /^[A-Za-z0-9_]{1,25}$/;

// OINK_VIDEO_PRESET values. Bitrate is keyed by resolution (matching the
// dashboard's recommended tiers); 1080p30 is the node default.
const VIDEO_PRESETS = Object.freeze({
  '720p30': { outputWidth: 1280, outputHeight: 720, fps: 30, bitrate: 4500 },
  '720p60': { outputWidth: 1280, outputHeight: 720, fps: 60, bitrate: 4500 },
  '1080p30': { outputWidth: 1920, outputHeight: 1080, fps: 30, bitrate: 6000 },
  '1080p60': { outputWidth: 1920, outputHeight: 1080, fps: 60, bitrate: 6000 },
  '1440p60': { outputWidth: 2560, outputHeight: 1440, fps: 60, bitrate: 9000 },
});

function isValidPreset(name) {
  return Object.prototype.hasOwnProperty.call(VIDEO_PRESETS, name);
}

// Trim + validate a Twitch channel name. Empty string is allowed (unset).
function normalizeChannel(value) {
  if (value === undefined || value === null) return '';
  if (typeof value !== 'string') throw new Error('twitchChannel must be a string');
  const trimmed = value.trim();
  if (trimmed && !CHANNEL_RE.test(trimmed)) {
    throw new Error('twitchChannel must be 1–25 chars of letters, digits or underscore');
  }
  return trimmed;
}

function settingsPath(stackDir) {
  return path.join(stackDir, SETTINGS_FILE);
}

function defaults(seed = {}) {
  return {
    welcomeComplete: seed.welcomeComplete === true,
    twitchChannel: normalizeChannel(seed.twitchChannel),
    // Whether OINK_VIDEO_PRESET was supplied at boot. The welcome screen treats
    // quality as "already provided" only when true — OBS always holds *some*
    // video settings, so live state can't tell a chosen preset from the default.
    presetProvided: seed.presetProvided === true,
  };
}

function readSettings(stackDir) {
  try {
    const data = JSON.parse(fs.readFileSync(settingsPath(stackDir), 'utf8'));
    if (data && typeof data === 'object') {
      return {
        ...defaults(),
        welcomeComplete: data.welcomeComplete === true,
        twitchChannel:
          typeof data.twitchChannel === 'string' ? data.twitchChannel : '',
        presetProvided: data.presetProvided === true,
      };
    }
  } catch {
    // fall through to defaults
  }
  return defaults();
}

// Seed the file once. Existing values win (dashboard edits persist across a
// setup re-run / restart).
function ensureSettings(stackDir, seed = {}) {
  const file = settingsPath(stackDir);
  if (fs.existsSync(file)) return readSettings(stackDir);
  const state = defaults(seed);
  writeSettings(stackDir, state);
  return state;
}

function writeSettings(stackDir, state) {
  const file = settingsPath(stackDir);
  const tmp = `${file}.tmp`;
  fs.mkdirSync(stackDir, { recursive: true });
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2) + '\n');
  fs.chmodSync(tmp, 0o600);
  fs.renameSync(tmp, file);
  return state;
}

module.exports = {
  CHANNEL_RE,
  VIDEO_PRESETS,
  isValidPreset,
  normalizeChannel,
  settingsPath,
  readSettings,
  ensureSettings,
  writeSettings,
};
