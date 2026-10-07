'use strict';
// SPDX-FileCopyrightText: 2026 OpenIRLNodeKit contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

// Status-update payload for the /api/ws controller event. Pure + requireable
// (no HTTP, no sockets) so it can be unit-tested with node:test; log-server.js
// owns the MediaMTX/OBS reads and the broadcast loop.
//
// ponytail: fields MediaMTX's control API cannot source are best-effort —
// router_rtt is always -1, muted stays false, volume stays 100, and
// media_state is derived from `ready`. Fill them properly if/when MediaMTX
// exposes RTT and we read OBS input audio.

const fs = require('fs');
const { CONFIG_FILES } = require('./config');

const STATUS_INTERVAL_MS = 2500;

// Low/offline bitrate thresholds live in the NOALBS switcher config the
// dashboard edits. Best-effort: an absent/corrupt file yields nulls, not a throw.
function readTriggers() {
  try {
    const cfg = JSON.parse(fs.readFileSync(CONFIG_FILES.noalbs, 'utf-8'));
    const t = (cfg.switcher && cfg.switcher.triggers) || {};
    return {
      low: Number.isFinite(t.low) ? t.low : null,
      offline: Number.isFinite(t.offline) ? t.offline : null,
    };
  } catch {
    return { low: null, offline: null };
  }
}

// Instantaneous bitrate (kbps) from a byte counter delta. Returns 0 on the
// first sample, a non-positive interval, or a counter that did not advance
// (idle/offline), so a slow tick never reports a negative/silly rate.
function computeBitrate(prevBytes, prevTs, bytes, ts) {
  if (!Number.isFinite(prevBytes) || !Number.isFinite(prevTs)) return 0;
  if (!Number.isFinite(bytes) || !Number.isFinite(ts)) return 0;
  const seconds = (ts - prevTs) / 1000;
  if (seconds <= 0) return 0;
  const delta = bytes - prevBytes;
  if (delta <= 0) return 0;
  return Math.round((delta * 8) / seconds / 1000);
}

// Keep only MediaMTX paths under this install's keyed namespace. Each becomes
// an ingest feed keyed by its label (`live/<key>/<label>`), so any encoder label
// the operator chooses is charted — not just the canonical `stream`.
function namespacePaths(paths, key) {
  const prefix = `live/${key}/`;
  const feeds = [];
  for (const p of Array.isArray(paths) ? paths : []) {
    if (!p || typeof p !== 'object') continue;
    const name = String(p.name || '');
    if (!name.startsWith(prefix)) continue;
    feeds.push({
      id: name.slice(prefix.length) || 'stream',
      name,
      type: p.source && p.source.type ? p.source.type : null,
      ready: p.ready === true,
      bytesReceived: Number.isFinite(p.bytesReceived) ? p.bytesReceived : 0,
    });
  }
  return feeds;
}

// Per-feed bitrate from each path's byte counter, carried across ticks by the
// caller's Map. Returns the feeds with their bitrate, the total across active
// feeds, and the next Map (only currently-listed feeds, so it cannot grow).
function updateIngestRates(prev, feeds, now) {
  const next = new Map();
  let totalBitrate = 0;
  const ingests = [];
  for (const feed of feeds) {
    const before = prev.get(feed.id);
    const bitrate = computeBitrate(before?.bytes, before?.ts, feed.bytesReceived, now);
    next.set(feed.id, { bytes: feed.bytesReceived, ts: now });
    totalBitrate += bitrate;
    ingests.push({ ...feed, bitrate });
  }
  return { ingests, totalBitrate, next };
}

function buildStatusUpdate({ ingests, totalBitrate = 0, scene, outputStatus, triggers }) {
  const feeds = (ingests || []).map((i) => ({
    id: i.id,
    // `name` is the full MediaMTX path (live/<key>/<label>) — never broadcast it,
    // the key is the publish/read credential and /api/ws is viewer-readable.
    type: i.type || 'unknown',
    media_state: i.ready ? 'OBS_MEDIA_STATE_PLAYING' : 'OBS_MEDIA_STATE_NONE',
    muted: false,
    volume: 100,
    router_bitrate: i.bitrate,
    router_rtt: -1,
  }));
  let main = null;
  for (const f of feeds) {
    if (f.router_bitrate > 0 && (!main || f.router_bitrate > main.router_bitrate)) main = f;
  }
  return {
    type: 'OpenIRLNodeKitStatusUpdate',
    ingests: feeds,
    main_ingest_id: main ? main.id : null,
    ingest_bitrate: totalBitrate,
    low_bitrate_trigger: triggers.low,
    offline_bitrate_trigger: triggers.offline,
    scene: scene || null,
    output_status: {
      stream_status: outputStatus.outputActive === true,
      stream_timecode: outputStatus.outputTimecode || '00:00:00.000',
    },
  };
}

module.exports = {
  STATUS_INTERVAL_MS,
  readTriggers,
  computeBitrate,
  namespacePaths,
  updateIngestRates,
  buildStatusUpdate,
};
