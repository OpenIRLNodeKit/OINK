'use strict';
// SPDX-FileCopyrightText: 2026 OpenIRLNodeKit contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

// Asset + avatar file handling for the OINK control-plane.
//
// Owns the single source of "here is a safe path under the assets dir" logic:
// name sanitization, MIME mapping, streaming uploads, avatar magic-byte
// sniffing, and a symlink-containment check so no path resolution can escape
// the configured directory.

const fs = require('fs');
const path = require('path');
const { freeBytes } = require('./disk');
const { InputError } = require('./errors');

const STACK_DIR = process.env.OINK_STACK_DIR || __dirname;

// Profile avatars are small thumbnails — 1 MB is plenty and keeps the
// per-user store lean. Files live under stack assets so they survive rebuilds.
const AVATAR_DIR = path.join(STACK_DIR, 'assets', 'avatars');
const AVATAR_MAX_BYTES = 1024 * 1024;

const ASSET_MIME = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.mp4': 'video/mp4',
  '.mov': 'video/quicktime',
  '.mkv': 'video/x-matroska',
  '.webm': 'video/webm',
  '.m4v': 'video/x-m4v',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
  '.m4a': 'audio/mp4',
  '.aac': 'audio/aac',
  '.flac': 'audio/flac',
  '.txt': 'text/plain; charset=utf-8',
  '.json': 'application/json',
  '.zip': 'application/zip',
};

// Reduce any supplied name (path segments, traversal, controls) to a safe
// single filename that can never escape the owning directory.
function sanitizeAssetName(raw) {
  const base = path.basename(String(raw || '').replace(/\\/g, '/')).trim();
  if (!base || base === '.' || base === '..') {
    throw new InputError('Invalid file name');
  }
  if (base.length > 255) {
    throw new InputError('File name is too long');
  }
  if (/[\u0000-\u001f\u007f]/.test(base)) {
    throw new InputError('File name contains invalid characters');
  }
  return base;
}

function mimeForAsset(name) {
  return ASSET_MIME[path.extname(name).toLowerCase()] || 'application/octet-stream';
}

// Stream the client body into an asset file, cleaning up the partial file if
// anything goes wrong. `maxBytes` caps the upload (Infinity = no fixed cap) and
// `freeDir` makes it stop when that filesystem fills, re-checked every 64 MiB.
// Writes honour backpressure so a multi-GB upload never buffers in memory.
function writeAssetStream(req, dest, opts = {}) {
  const maxBytes = Number.isFinite(opts.maxBytes) ? opts.maxBytes : Infinity;
  const freeDir = opts.freeDir || '';
  const limitMessage = opts.limitMessage
    || (freeDir ? 'Not enough disk space for this upload'
      : `File exceeds the ${(maxBytes / (1024 * 1024)).toFixed(0)} MB limit`);
  const CHECK_EVERY = 64 * 1024 * 1024;

  return new Promise((resolve, reject) => {
    const out = fs.createWriteStream(dest, { flags: 'w', mode: 0o644 });
    let size = 0;
    let settled = false;
    let nextFreeCheck = CHECK_EVERY;

    const fail = (err) => {
      if (settled) return;
      settled = true;
      out.destroy();
      try { fs.unlinkSync(dest); } catch {}
      req.resume(); // Drain the rest so the client can read the error response.
      reject(err);
    };

    req.on('data', (chunk) => {
      if (settled) return;
      size += chunk.length;
      let full = size > maxBytes;
      if (!full && freeDir && size >= nextFreeCheck) {
        nextFreeCheck += CHECK_EVERY;
        try {
          if (freeBytes(freeDir) <= 0) full = true;
        } catch {
          // statfs failed: keep the upload going; the write stream will report
          // ENOSPC if the disk really is full.
        }
      }
      if (full) {
        fail(new InputError(limitMessage));
        return;
      }
      if (!out.write(chunk)) {
        req.pause();
        out.once('drain', () => {
          if (!settled) req.resume();
        });
      }
    });
    req.on('end', () => {
      if (settled) return;
      out.end(() => {
        if (settled) return;
        settled = true;
        resolve(size);
      });
    });
    req.on('error', fail);
    out.on('error', fail);
  });
}

// Resolve a file under a root dir and verify the real path stays inside the real
// root, so a symlink planted in the directory can never be served/deleted
// (belt-and-braces on top of sanitizeAssetName).
function assertContained(filePath, rootDir) {
  const root = fs.realpathSync(rootDir);
  let resolved;
  try {
    resolved = fs.realpathSync(filePath);
  } catch {
    resolved = path.resolve(filePath);
  }
  const rel = path.relative(root, resolved);
  if (rel === '' || rel === '..' || rel.startsWith('..' + path.sep) || path.isAbsolute(rel)) {
    throw new InputError('Path escapes the configured directory');
  }
  return resolved;
}

function avatarPath(userId) {
  return path.join(AVATAR_DIR, String(userId).replace(/[^a-zA-Z0-9-]/g, ''));
}

// Avatars accept only the raster image types; SVG/HTML and anything else are
// refused. Reuses the asset sniff so magic-byte truth lives in one place.
function sniffAvatarType(filePath) {
  const type = sniffAssetType(filePath);
  return ['image/png', 'image/jpeg', 'image/gif', 'image/webp'].includes(type) ? type : null;
}

// ── OBS asset sniffing ────────────────────────────────────────────────────────
// Assets are generic OBS overlay files (images, clips, sound). Uploads are
// trusted by CONTENT, not by the X-Filename extension: the magic bytes decide
// the type. `.svg`/`.txt`/`.html` have no reliable magic and are refused (they
// could otherwise be served as a script). Read only a 32-byte header — the
// uploads can be many GB, so readFileSync here would be a memory bomb.

// Only container families with more than one MIME need an entry: `expected ===
// sniffed` already matches an exact type, so a MOV-branded file named `.mp4`
// (or vice versa) is the only case this resolves.
const ASSET_FAMILY = {
  'video/mp4': 'bmff',
  'video/quicktime': 'bmff',
  'video/x-m4v': 'bmff',
  'audio/mp4': 'bmff',
  'video/x-matroska': 'matroska',
  'video/webm': 'matroska',
};

function _readHeader(filePath) {
  const fd = fs.openSync(filePath, 'r');
  try {
    const buf = Buffer.alloc(32);
    const read = fs.readSync(fd, buf, 0, 32, 0);
    return buf.subarray(0, read);
  } finally {
    fs.closeSync(fd);
  }
}

function sniffAssetType(filePath) {
  const b = _readHeader(filePath);
  if (b.length >= 8 &&
      b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 &&
      b[4] === 0x0d && b[5] === 0x0a && b[6] === 0x1a && b[7] === 0x0a) {
    return 'image/png';
  }
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) {
    return 'image/jpeg';
  }
  if (b.length >= 6) {
    const head6 = b.toString('latin1', 0, 6);
    if (head6 === 'GIF87a' || head6 === 'GIF89a') return 'image/gif';
  }
  if (b.length >= 12 && b.toString('latin1', 0, 4) === 'RIFF') {
    const riffType = b.toString('latin1', 8, 12);
    if (riffType === 'WEBP') return 'image/webp';
    if (riffType === 'WAVE') return 'audio/wav';
  }
  if (b.length >= 4 && b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3) {
    return 'video/x-matroska'; // EBML — WebM/MKV share the family
  }
  if (b.length >= 12 && b.toString('latin1', 4, 8) === 'ftyp') {
    const brand = b.toString('latin1', 8, 12);
    if (brand.startsWith('M4A') || brand.startsWith('M4B')) return 'audio/mp4';
    if (brand.startsWith('M4V')) return 'video/x-m4v';
    if (brand === 'qt  ') return 'video/quicktime';
    return 'video/mp4';
  }
  if (b.length >= 4 && b.toString('latin1', 0, 4) === 'OggS') return 'audio/ogg';
  if (b.length >= 4 && b.toString('latin1', 0, 4) === 'fLaC') return 'audio/flac';
  if (b.length >= 3 && b.toString('latin1', 0, 3) === 'ID3') return 'audio/mpeg';
  if (b.length >= 2 && b[0] === 0xff) {
    // ADTS AAC sync (FF F1 / FF F9) vs MPEG audio frame sync (FF Ex/Fx with a
    // non-zero layer field).
    if (b[1] === 0xf1 || b[1] === 0xf9) return 'audio/aac';
    if ((b[1] & 0xe0) === 0xe0 && ((b[1] >> 1) & 0x03) !== 0) return 'audio/mpeg';
  }
  // ZIP local-file (PK\x03\x04), empty-archive (PK\x05\x06), and spanned
  // (PK\x07\x08) headers.
  if (b.length >= 4 && b[0] === 0x50 && b[1] === 0x4b &&
      ((b[2] === 0x03 && b[3] === 0x04) || (b[2] === 0x05 && b[3] === 0x06) ||
       (b[2] === 0x07 && b[3] === 0x08))) {
    return 'application/zip';
  }
  // JSON has no magic number — treat a leading `{`/`[` (after an optional UTF-8
  // BOM and ASCII whitespace) as the signature. Bytes are trusted, not parsed.
  // ponytail: first `{`/`[` within 32 bytes; bump header size if JSON with long
  // leading whitespace must upload.
  let i = 0;
  if (b.length >= 3 && b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf) i = 3;
  while (i < b.length && (b[i] === 0x20 || b[i] === 0x09 || b[i] === 0x0a || b[i] === 0x0d)) i++;
  if (i < b.length && (b[i] === 0x7b || b[i] === 0x5b)) return 'application/json';
  return null;
}

function assetTypeMatches(name, sniffed) {
  if (!sniffed) return false;
  const expected = mimeForAsset(name);
  if (expected === sniffed) return true;
  const expectedFamily = ASSET_FAMILY[expected];
  return Boolean(expectedFamily) && expectedFamily === ASSET_FAMILY[sniffed];
}

// Validate a staged upload against its claimed name and move it into place.
// Returns { ok: true, contentType } on success, or { ok: false, error } when the
// content is unsupported/mismatched — in which case the temp file is removed and
// the destination (the previous asset, if any) is left untouched.
function commitAsset(tmpPath, finalPath, name) {
  let sniffed;
  try {
    sniffed = sniffAssetType(tmpPath);
  } catch (e) {
    try { fs.unlinkSync(tmpPath); } catch {}
    throw e;
  }
  if (!assetTypeMatches(name, sniffed)) {
    try { fs.unlinkSync(tmpPath); } catch {}
    return {
      ok: false,
      error: sniffed
        ? `File content (${sniffed}) does not match the "${name}" extension`
        : 'Unsupported file — PNG/JPEG/GIF/WebP images, video, audio, and JSON/ZIP only',
    };
  }
  fs.renameSync(tmpPath, finalPath);
  return { ok: true, contentType: sniffed };
}

module.exports = {
  AVATAR_DIR,
  AVATAR_MAX_BYTES,
  sanitizeAssetName,
  mimeForAsset,
  writeAssetStream,
  assertContained,
  avatarPath,
  sniffAvatarType,
  sniffAssetType,
  assetTypeMatches,
  commitAsset,
};
