'use strict';
// SPDX-FileCopyrightText: 2026 OpenIRLNodeKit contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

// Recording stream/thumbnail handling for the OINK control-plane.
//
// Owns the recording-name whitelist, HTTP Range serve (for <video> seeking),
// and the size-capped, deduplicated ffmpeg thumbnail queue. No HTTP routing
// here — this module is the recording subsystem only.

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { mimeForAsset } = require('./assets');
const { BusyError } = require('./errors');

const OBS_RECORDING_DIR = process.env.OBS_RECORDING_DIR || '/obs-recordings';

const RECORDING_EXT = new Set(['.mp4', '.mov', '.mkv', '.webm', '.m4v']);

// Only treat recorded-video names as valid for the recordings API so arbitrary
// files on the mounted directory can never be served or deleted through it.
function isRecordingName(name) {
  return RECORDING_EXT.has(path.extname(name).toLowerCase());
}

function recordingThumbPath(name) {
  return path.join(
    OBS_RECORDING_DIR,
    '.thumbs',
    path.basename(name, path.extname(name)) + '.jpg',
  );
}

// Serve a recording with HTTP Range support so <video> can seek. Handles the
// single byte-range requests browsers send for media (206 + Content-Range) and
// falls back to a full 200 stream otherwise. `download=true` attaches instead.
function serveFileWithRange(req, res, filePath, fileName, download) {
  const total = fs.statSync(filePath).size;
  const mime = mimeForAsset(fileName);
  const disposition = `${download ? 'attachment' : 'inline'}; filename="${fileName.replace(/"/g, '')}"`;
  const m = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || '');
  if (!m || (m[1] === '' && m[2] === '')) {
    res.writeHead(200, {
      'Content-Type': mime,
      'Content-Length': total,
      'Accept-Ranges': 'bytes',
      'Content-Disposition': disposition,
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    });
    fs.createReadStream(filePath).pipe(res);
    return;
  }
  const start = m[1] === '' ? Math.max(0, total - Number(m[2])) : Number(m[1]);
  const end = m[2] === '' ? total - 1 : Math.min(total - 1, Number(m[2]));
  if (start > end || start >= total) {
    res.writeHead(416, { 'Content-Range': `bytes */${total}` });
    res.end();
    return;
  }
  res.writeHead(206, {
    'Content-Type': mime,
    'Content-Length': end - start + 1,
    'Content-Range': `bytes ${start}-${end}/${total}`,
    'Accept-Ranges': 'bytes',
    'Content-Disposition': disposition,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  fs.createReadStream(filePath, { start, end }).pipe(res);
}

// Thumbnail generation: dedupe per recording (thumbJobs shares one in-flight job
// between clients asking for the same clip) AND cap total concurrent ffmpeg
// processes so a caller cannot fan out unbounded generation across many clips.
const THUMB_MAX_CONCURRENT = 2; // ffmpeg thumbnail processes running at once
const THUMB_MAX_PENDING = 8;    // queued requests beyond this are rejected
const thumbJobs = new Map();    // name -> promise (queued or in-flight)
const thumbWaiting = [];        // {name, resolve, reject} FIFO
let thumbActive = 0;

function _runThumb(name) {
  thumbActive += 1;
  const src = path.join(OBS_RECORDING_DIR, name);
  const dest = recordingThumbPath(name);
  const tmp = dest.replace(/\.jpg$/, `.tmp-${process.pid}.jpg`);
  return new Promise((resolve, reject) => {
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    spawn('ffmpeg', [
      '-y',
      '-ss', '1',
      '-i', src,
      '-frames:v', '1',
      '-update', '1',
      '-vf', 'scale=320:-2',
      '-q:v', '4',
      tmp,
    ], { timeout: 30000 })
      .on('close', (code) => {
        if (code === 0 && fs.existsSync(tmp)) {
          fs.renameSync(tmp, dest);
          resolve(dest);
        } else {
          try { fs.unlinkSync(tmp); } catch {}
          reject(new Error(`Thumbnail generation failed for ${name}`));
        }
      })
      .on('error', (err) => {
        try { fs.unlinkSync(tmp); } catch {}
        reject(err);
      });
  }).finally(() => {
    thumbActive -= 1;
    _pumpThumbs();
  });
}

// Start queued thumbnail jobs up to the concurrency cap.
function _pumpThumbs() {
  while (thumbActive < THUMB_MAX_CONCURRENT && thumbWaiting.length > 0) {
    const item = thumbWaiting.shift();
    _runThumb(item.name).then(item.resolve, item.reject);
  }
}

// Generate (and cache) a preview frame ~1s into the recording. Cache lives in a
// hidden .thumbs subdir so the recordings list page stays clean.
function ensureRecordingThumb(name) {
  const dest = recordingThumbPath(name);
  if (fs.existsSync(dest)) return Promise.resolve(dest);
  if (thumbJobs.has(name)) return thumbJobs.get(name);
  const job = new Promise((resolve, reject) => {
    if (thumbWaiting.length >= THUMB_MAX_PENDING) {
      reject(new BusyError('Thumbnail queue busy — try again shortly'));
      return;
    }
    thumbWaiting.push({ name, resolve, reject });
    _pumpThumbs();
  });
  thumbJobs.set(name, job);
  job.then(
    () => thumbJobs.delete(name),
    () => thumbJobs.delete(name),
  );
  return job;
}

module.exports = {
  OBS_RECORDING_DIR,
  RECORDING_EXT,
  isRecordingName,
  recordingThumbPath,
  serveFileWithRange,
  ensureRecordingThumb,
};
