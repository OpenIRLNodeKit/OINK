'use strict';
// SPDX-FileCopyrightText: 2026 OpenIRLNodeKit contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

// Unit tests for obs-bridge.centeredBoundsTransform — the vertical-canvas
// ingest mirror keeps the source's aspect ratio and centers it in the 9:16
// frame instead of squishing it (OBS_BOUNDS_SCALE_INNER at provision).

const { test } = require('node:test');
const assert = require('node:assert');

// Import the pure helper without touching a live OBS: the module reads
// components.json + host-info.json at load; both exist in stack/.
process.env.OINK_STACK_DIR = require('path').join(__dirname, '..', 'stack');
const { centeredBoundsTransform, mapIngestControls, streamOutputParams } = require('./obs-bridge.js');

const close = (a, b) => Math.abs(a - b) < 1e-9;

test('16:9 source letterboxes into the vertical canvas, centered on X=0', () => {
  const t = centeredBoundsTransform(1280, 720, 1080, 1920);
  assert.ok(close(t.boundsWidth, 1080), 'fills full width');
  assert.ok(close(t.boundsHeight, 607.5), 'height scaled by aspect');
  assert.ok(close(t.positionX, 0), 'centered horizontally');
  assert.ok(close(t.positionY, 656.25), 'centered vertically');
});

test('9:16 source fills the whole vertical canvas', () => {
  const t = centeredBoundsTransform(720, 1280, 1080, 1920);
  assert.ok(close(t.boundsWidth, 1080));
  assert.ok(close(t.boundsHeight, 1920));
  assert.ok(close(t.positionX, 0));
  assert.ok(close(t.positionY, 0));
});

test('21:9 ultrawide source fits inside width 1080', () => {
  const t = centeredBoundsTransform(2560, 1080, 1080, 1920);
  assert.ok(close(t.boundsWidth, 1080));
  assert.ok(close(t.boundsHeight, 455.625));
  assert.ok(close(t.positionX, 0));
  assert.ok(close(t.positionY, 732.1875));
});

test('zero/missing source dims fall back to 16:9', () => {
  const t = centeredBoundsTransform(0, 0, 1080, 1920);
  assert.ok(close(t.boundsWidth, 1080));
  assert.ok(close(t.boundsHeight, 607.5));
  assert.ok(close(t.positionY, 656.25));
});

// ── mapIngestControls (per-ingest mute/visibility join) ──────────────────────

test('mapIngestControls joins existence, mute, visibility, and restartability', () => {
  const out = mapIngestControls({
    mainItems: [
      { sourceName: 'test', sceneItemEnabled: true },
      { sourceName: 'angle1', sceneItemEnabled: false },
    ],
    verticalItems: [{ sourceName: 'test', sceneItemEnabled: true }],
    inputNames: ['test', 'angle1', 'unused'],
    mutes: { test: false, angle1: true },
    restartable: { test: true, angle1: false },
    names: ['test', 'angle1', 'ghost'],
  });
  assert.deepStrictEqual(out, [
    { name: 'test', muted: false, visible: true, vertical: true, restartable: true },
    { name: 'angle1', muted: true, visible: false, vertical: null, restartable: false },
  ]);
});

test('mapIngestControls omits names with no OBS input and tolerates unknowns', () => {
  const out = mapIngestControls({
    mainItems: [],
    verticalItems: [],
    inputNames: ['solo'],
    mutes: {},
    names: ['solo', 'missing'],
  });
  assert.deepStrictEqual(out, [
    { name: 'solo', muted: null, visible: null, vertical: null, restartable: false },
  ]);
  assert.deepStrictEqual(mapIngestControls({ names: [] }), []);
});

// ── streamOutputParams (Simple vs Advanced profile mismatch) ─────────────────

test('streamOutputParams reads Simple output when OBS is in Simple mode', () => {
  const out = streamOutputParams(
    'Simple',
    { encoder: 'jim_nvenc', bitrate: '7500' },
    { encoder: 'obs_x264', bitrate: 6000 },
  );
  assert.deepStrictEqual(out, { encoder: 'nvenc', bitrate: 7500, outputMode: 'Simple' });
});

test('streamOutputParams reads Advanced output when OBS is in Advanced mode', () => {
  const out = streamOutputParams(
    'Advanced',
    { encoder: 'jim_nvenc', bitrate: '7500' },
    { encoder: 'obs_x264', bitrate: 6000 },
  );
  assert.deepStrictEqual(out, { encoder: 'x264', bitrate: 6000, outputMode: 'Advanced' });
  assert.deepStrictEqual(streamOutputParams('Advanced', {}, {}).bitrate, 0);
});
