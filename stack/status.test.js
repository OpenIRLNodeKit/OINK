'use strict';
// SPDX-FileCopyrightText: 2026 OpenIRLNodeKit contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

// Unit tests for stack/status.js — bitrate math, trigger read, payload shape.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const status = require('./status');
const config = require('./config');

test('computeBitrate: first sample and bad intervals are 0', () => {
  assert.strictEqual(status.computeBitrate(null, null, 1000, 1000), 0);
  assert.strictEqual(status.computeBitrate(0, 1000, 5000, 1000), 0); // dt = 0
  assert.strictEqual(status.computeBitrate(0, 1000, 5000, 900), 0); // dt < 0
  assert.strictEqual(status.computeBitrate(0, 0, NaN, 1000), 0);
  assert.strictEqual(status.computeBitrate(NaN, 0, 1000, 1000), 0);
});

test('computeBitrate: 125000 bytes/s is 1000 kbps', () => {
  assert.strictEqual(status.computeBitrate(0, 0, 125000, 1000), 1000);
  assert.strictEqual(status.computeBitrate(0, 0, 312500, 2500), 1000); // over 2.5 s
});

test('computeBitrate: a counter that did not advance reports 0', () => {
  assert.strictEqual(status.computeBitrate(10000, 0, 10000, 1000), 0);
  assert.strictEqual(status.computeBitrate(10000, 0, 9000, 1000), 0);
});

test('readTriggers: reads low/offline from the noalbs switcher, nulls on miss', () => {
  const original = config.CONFIG_FILES.noalbs;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oink-status-'));
  try {
    const file = path.join(dir, 'config.json');
    fs.writeFileSync(file, JSON.stringify({ switcher: { triggers: { low: 900, offline: 300 } } }));
    config.CONFIG_FILES.noalbs = file;
    assert.deepStrictEqual(status.readTriggers(), { low: 900, offline: 300 });

    config.CONFIG_FILES.noalbs = path.join(dir, 'nope.json');
    assert.deepStrictEqual(status.readTriggers(), { low: null, offline: null });
  } finally {
    config.CONFIG_FILES.noalbs = original;
  }
});

test('namespacePaths: keeps only the keyed namespace and derives the label', () => {
  const paths = [
    { name: 'live/k/stream', ready: false, bytesReceived: 0, source: null },
    { name: 'live/k/test', ready: true, bytesReceived: 999, source: { type: 'srtConn' } },
    { name: 'live/other/test', ready: true, bytesReceived: 1, source: { type: 'rtmpConn' } },
  ];
  assert.deepStrictEqual(status.namespacePaths(paths, 'k'), [
    { id: 'stream', name: 'live/k/stream', type: null, ready: false, bytesReceived: 0 },
    { id: 'test', name: 'live/k/test', type: 'srtConn', ready: true, bytesReceived: 999 },
  ]);
});

test('updateIngestRates: first tick 0, then per-feed kbps + total, vanished feeds pruned', () => {
  const feeds = [
    { id: 'a', name: 'live/k/a', type: 'srtConn', ready: true, bytesReceived: 125000 },
    { id: 'b', name: 'live/k/b', type: 'rtmpConn', ready: true, bytesReceived: 0 },
  ];
  const first = status.updateIngestRates(new Map(), feeds, 1000);
  assert.deepStrictEqual(first.ingests.map((i) => i.bitrate), [0, 0]);
  assert.strictEqual(first.totalBitrate, 0);

  const grown = [
    { ...feeds[0], bytesReceived: 250000 },
    { ...feeds[1], bytesReceived: 0 },
  ];
  const second = status.updateIngestRates(first.next, grown, 2000);
  assert.deepStrictEqual(second.ingests.map((i) => i.bitrate), [1000, 0]);
  assert.strictEqual(second.totalBitrate, 1000);

  const third = status.updateIngestRates(second.next, [grown[0]], 3000);
  assert.deepStrictEqual([...third.next.keys()], ['a']);
});

test('buildStatusUpdate: one entry per feed, busiest as main, with the total', () => {
  const update = status.buildStatusUpdate({
    ingests: [
      { id: 'stream', name: 'live/k/stream', type: null, ready: false, bitrate: 0 },
      { id: 'test', name: 'live/k/test', type: 'srtConn', ready: true, bitrate: 4200 },
    ],
    totalBitrate: 4200,
    scene: 'main',
    outputStatus: { outputActive: true, outputTimecode: '00:01:02.500' },
    triggers: { low: 900, offline: 300 },
  });
  assert.strictEqual(update.type, 'OpenIRLNodeKitStatusUpdate');
  assert.strictEqual(update.main_ingest_id, 'test');
  assert.strictEqual(update.ingest_bitrate, 4200);
  assert.strictEqual(update.low_bitrate_trigger, 900);
  assert.strictEqual(update.offline_bitrate_trigger, 300);
  assert.strictEqual(update.scene, 'main');
  assert.strictEqual(update.output_status.stream_status, true);
  assert.strictEqual(update.output_status.stream_timecode, '00:01:02.500');
  assert.strictEqual(update.ingests.length, 2);
  assert.strictEqual(update.ingests[0].media_state, 'OBS_MEDIA_STATE_NONE');
  assert.strictEqual(update.ingests[1].name, undefined);
  assert.ok(!JSON.stringify(update).includes('live/k/'), 'raw ingest path must not leak');
  assert.strictEqual(update.ingests[1].type, 'srtConn');
  assert.strictEqual(update.ingests[1].router_bitrate, 4200);
  assert.strictEqual(update.ingests[1].media_state, 'OBS_MEDIA_STATE_PLAYING');
});

test('buildStatusUpdate: no feeds and no OBS still yield a valid packet', () => {
  const update = status.buildStatusUpdate({
    ingests: [],
    totalBitrate: 0,
    scene: null,
    outputStatus: {},
    triggers: { low: null, offline: null },
  });
  assert.deepStrictEqual(update.ingests, []);
  assert.strictEqual(update.main_ingest_id, null);
  assert.strictEqual(update.ingest_bitrate, 0);
  assert.strictEqual(update.scene, null);
  assert.strictEqual(update.output_status.stream_status, false);
  assert.strictEqual(update.output_status.stream_timecode, '00:00:00.000');
});
