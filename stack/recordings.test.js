'use strict';
// SPDX-FileCopyrightText: 2026 OpenIRLNodeKit contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

// Unit tests for stack/recordings.js — recording-name whitelist and the
// Range-aware stream serving path.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Writable } = require('node:stream');
const { serveFileWithRange, isRecordingName, recordingThumbPath, OBS_RECORDING_DIR } = require('./recordings');


test('isRecordingName only accepts video extensions', () => {
  assert.strictEqual(isRecordingName('clip.mp4'), true);
  assert.strictEqual(isRecordingName('clip.MOV'), true);
  assert.strictEqual(isRecordingName('clip.mkv'), true);
  assert.strictEqual(isRecordingName('notes.txt'), false);
  assert.strictEqual(isRecordingName('no-ext'), false);
});

test('recordingThumbPath nests under a hidden thumbs dir', () => {
  const thumb = recordingThumbPath('clip.mp4');
  assert.ok(thumb.endsWith(path.join('.thumbs', 'clip.jpg')));
  assert.strictEqual(path.dirname(path.dirname(thumb)), OBS_RECORDING_DIR);
});

function _fakeRes() {
  // A real Writable so createReadStream().pipe(res) works; writeHead captures the
  // status + headers synchronously for assertions.
  const chunks = [];
  const res = new Writable({
    write(chunk, _enc, cb) { chunks.push(chunk); cb(); },
  });
  res._status = 0;
  res._headers = null;
  res.writeHead = function writeHead(status, headers) {
    this._status = status;
    this._headers = headers;
  };
  return res;
}

function _file(size = 1000) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rec-'));
  const p = path.join(dir, 'video.mp4');
  fs.writeFileSync(p, Buffer.alloc(size, 7));
  return p;
}

test('serveFileWithRange serves a full 200 stream without a Range header', () => {
  const file = _file(500);
  const res = _fakeRes();
  serveFileWithRange({ headers: {} }, res, file, 'video.mp4', false);
  assert.strictEqual(res._status, 200);
  assert.strictEqual(res._headers['Content-Length'], 500);
  assert.strictEqual(res._headers['Accept-Ranges'], 'bytes');
  assert.strictEqual(res._headers['X-Content-Type-Options'], 'nosniff');
});

test('serveFileWithRange honors a single byte Range (206)', () => {
  const file = _file(1000);
  const res = _fakeRes();
  serveFileWithRange({ headers: { range: 'bytes=100-199' } }, res, file, 'video.mp4', false);
  assert.strictEqual(res._status, 206);
  assert.strictEqual(res._headers['Content-Length'], 100);
  assert.strictEqual(res._headers['Content-Range'], 'bytes 100-199/1000');
});

test('serveFileWithRange returns 416 for an unsatisfiable range', () => {
  const file = _file(100);
  const res = _fakeRes();
  serveFileWithRange({ headers: { range: 'bytes=500-600' } }, res, file, 'video.mp4', false);
  assert.strictEqual(res._status, 416);
  assert.strictEqual(res._headers['Content-Range'], 'bytes */100');
});

test('serveFileWithRange attaches when download=1', () => {
  const file = _file(10);
  const res = _fakeRes();
  serveFileWithRange({ headers: {} }, res, file, 'video.mp4', true);
  assert.ok(res._headers['Content-Disposition'].startsWith('attachment'));
});
