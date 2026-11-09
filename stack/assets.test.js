'use strict';
// SPDX-FileCopyrightText: 2026 OpenIRLNodeKit contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

// Unit tests for stack/assets.js — name sanitization, MIME mapping, avatar
// magic-byte sniffing, and symlink containment.

const { test } = require('node:test');
const assert = require('node:assert');
const { Readable } = require('node:stream');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { InputError } = require('./errors');

const assets = require('./assets');


test('sanitizeAssetName strips directory traversal', () => {
  assert.strictEqual(assets.sanitizeAssetName('../etc/passwd'), 'passwd');
  assert.strictEqual(assets.sanitizeAssetName('a/../../b.mp4'), 'b.mp4');
  assert.strictEqual(assets.sanitizeAssetName('C:\\Users\\x\\file.txt'), 'file.txt');
});

test('sanitizeAssetName rejects dot-dot and control chars', () => {
  assert.throws(() => assets.sanitizeAssetName('..'), InputError);
  assert.throws(() => assets.sanitizeAssetName('.'), InputError);
  assert.throws(() => assets.sanitizeAssetName('a\u0000b'), InputError);
  assert.throws(() => assets.sanitizeAssetName('  '), InputError);
});

test('sanitizeAssetName rejects overlong names', () => {
  assert.throws(() => assets.sanitizeAssetName('x'.repeat(300)), InputError);
});

test('mimeForAsset maps known and unknown extensions', () => {
  assert.strictEqual(assets.mimeForAsset('a.png'), 'image/png');
  assert.strictEqual(assets.mimeForAsset('a.MKV'), 'video/x-matroska');
  assert.strictEqual(assets.mimeForAsset('a.json'), 'application/json');
  assert.strictEqual(assets.mimeForAsset('a.zip'), 'application/zip');
  assert.strictEqual(assets.mimeForAsset('a.bin'), 'application/octet-stream');
});

test('sniffAvatarType identifies images by magic bytes', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sniff-'));
  const png = path.join(dir, 'a.png');
  fs.writeFileSync(png, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]));
  assert.strictEqual(assets.sniffAvatarType(png), 'image/png');

  const jpg = path.join(dir, 'b.jpg');
  fs.writeFileSync(jpg, Buffer.from([0xff, 0xd8, 0xff, 1, 2, 3]));
  assert.strictEqual(assets.sniffAvatarType(jpg), 'image/jpeg');

  const svg = path.join(dir, 'c.svg');
  fs.writeFileSync(svg, '<svg></svg>');
  assert.strictEqual(assets.sniffAvatarType(svg), null); // SVG refused
});

test('assertContained allows a normal file inside the root', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'contain-'));
  const inside = path.join(root, 'file.txt');
  fs.writeFileSync(inside, 'x');
  assert.strictEqual(assets.assertContained(inside, root), inside);
});

test('assertContained rejects a symlink that escapes the root', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'contain-'));
  const outside = path.join(os.tmpdir(), 'outside-' + Date.now() + '.txt');
  fs.writeFileSync(outside, 'secret');
  const link = path.join(root, 'link');
  fs.symlinkSync(outside, link);
  assert.throws(() => assets.assertContained(link, root), InputError);
});

test('avatarPath strips non-alphanumeric user ids', () => {
  const p = assets.avatarPath('../../etc/passwd');
  assert.strictEqual(path.dirname(p), assets.AVATAR_DIR);
  const base = path.basename(p);
  assert.ok(!base.includes('..') && !base.includes('/'));
  assert.strictEqual(path.basename(assets.avatarPath('user-1')), 'user-1');
});

// ── sniffAssetType / assetTypeMatches ─────────────────────────────────────────

function writeMagic(ext, bytes) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'asset-sniff-'));
  const p = path.join(dir, 'x' + ext);
  fs.writeFileSync(p, Buffer.from(bytes));
  return p;
}

test('sniffAssetType identifies the accepted asset families', () => {
  const iso = (brand) => [0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70, ...Buffer.from(brand, 'latin1')];
  const riff = (type) => [...Buffer.from('RIFF'), 0, 0, 0, 0, ...Buffer.from(type, 'latin1')];
  const cases = [
    ['.png', [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 'image/png'],
    ['.jpg', [0xff, 0xd8, 0xff, 0xe0], 'image/jpeg'],
    ['.gif', [...Buffer.from('GIF89a')], 'image/gif'],
    ['.webp', riff('WEBP'), 'image/webp'],
    ['.mp4', iso('isom'), 'video/mp4'],
    ['.mov', iso('qt  '), 'video/quicktime'],
    ['.m4v', iso('M4V '), 'video/x-m4v'],
    ['.m4a', iso('M4A '), 'audio/mp4'],
    ['.mkv', [0x1a, 0x45, 0xdf, 0xa3], 'video/x-matroska'],
    ['.webm', [0x1a, 0x45, 0xdf, 0xa3], 'video/x-matroska'],
    ['.wav', riff('WAVE'), 'audio/wav'],
    ['.ogg', [...Buffer.from('OggS')], 'audio/ogg'],
    ['.flac', [...Buffer.from('fLaC')], 'audio/flac'],
    ['.mp3', [...Buffer.from('ID3')], 'audio/mpeg'],
    ['.aac', [0xff, 0xf1], 'audio/aac'],
    ['.zip', [...Buffer.from('PK\x03\x04')], 'application/zip'],
    ['.zip', [...Buffer.from('PK\x05\x06')], 'application/zip'],
  ];
  for (const [ext, bytes, want] of cases) {
    assert.strictEqual(assets.sniffAssetType(writeMagic(ext, bytes)), want, ext);
  }
});

test('sniffAssetType refuses svg/text/html (no usable magic)', () => {
  for (const [ext, body] of [['.svg', '<svg></svg>'], ['.txt', 'hello'], ['.html', '<html>']]) {
    assert.strictEqual(assets.sniffAssetType(writeMagic(ext, Buffer.from(body))), null, ext);
  }
});

test('sniffAssetType detects JSON by a leading brace/bracket', () => {
  const cases = [
    ['{"a":1}', 'application/json'],
    ['[1,2]', 'application/json'],
    ['\u00ef\u00bb\u00bf{"x":1}', 'application/json'],
    ['  [\n  {"x":1}\n]', 'application/json'],
  ];
  for (const [body, want] of cases) {
    assert.strictEqual(assets.sniffAssetType(writeMagic('.json', Buffer.from(body, 'latin1'))), want, body);
  }
  // `.json`-named but not JSON content → refused.
  assert.strictEqual(assets.sniffAssetType(writeMagic('.json', Buffer.from('hello'))), null);
});

test('assetTypeMatches rejects an extension/content mismatch', () => {
  const png = assets.sniffAssetType(writeMagic('.png',
    [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  assert.strictEqual(png, 'image/png');
  assert.strictEqual(assets.assetTypeMatches('overlay.png', png), true);
  assert.strictEqual(assets.assetTypeMatches('evil.mp4', png), false);
  assert.strictEqual(assets.assetTypeMatches('evil.txt', png), false);
  // BMFF brands are interchangeable within the family.
  assert.strictEqual(assets.assetTypeMatches('clip.mp4', 'video/quicktime'), true);
  assert.strictEqual(assets.assetTypeMatches('clip.mp4', null), false);
  // JSON content only matches a `.json` name.
  assert.strictEqual(assets.assetTypeMatches('scene.json', 'application/json'), true);
  assert.strictEqual(assets.assetTypeMatches('clip.mp4', 'application/json'), false);
  // ZIP content only matches a `.zip` name.
  assert.strictEqual(assets.assetTypeMatches('pack.zip', 'application/zip'), true);
  assert.strictEqual(assets.assetTypeMatches('clip.mp4', 'application/zip'), false);
});

test('sniffAssetType reads only a header (never the whole file)', () => {
  const p = writeMagic('.png', [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
  const real = fs.readFileSync;
  fs.readFileSync = () => { throw new Error('readFileSync must not be used on assets'); };
  try {
    assert.strictEqual(assets.sniffAssetType(p), 'image/png');
  } finally {
    fs.readFileSync = real;
  }
});

// ── commitAsset (stage → sniff → rename/reject) ──────────────────────────────

const PNG_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'commit-'));
}

test('commitAsset moves a matching upload into place', () => {
  const dir = tmpDir();
  const tmp = path.join(dir, 'overlay.png.up-1');
  const finalPath = path.join(dir, 'overlay.png');
  fs.writeFileSync(tmp, PNG_BYTES);
  const r = assets.commitAsset(tmp, finalPath, 'overlay.png');
  assert.deepStrictEqual(r, { ok: true, contentType: 'image/png' });
  assert.ok(fs.existsSync(finalPath));
  assert.ok(!fs.existsSync(tmp));
});

test('commitAsset moves a JSON upload into place', () => {
  const dir = tmpDir();
  const tmp = path.join(dir, 'scene.json.up-1');
  const finalPath = path.join(dir, 'scene.json');
  fs.writeFileSync(tmp, '{"name":"intro"}');
  const r = assets.commitAsset(tmp, finalPath, 'scene.json');
  assert.deepStrictEqual(r, { ok: true, contentType: 'application/json' });
  assert.ok(fs.existsSync(finalPath));
  assert.ok(!fs.existsSync(tmp));
});

test('commitAsset moves a ZIP upload into place', () => {
  const dir = tmpDir();
  const tmp = path.join(dir, 'pack.zip.up-1');
  const finalPath = path.join(dir, 'pack.zip');
  fs.writeFileSync(tmp, Buffer.from('PK\x03\x04rest'));
  const r = assets.commitAsset(tmp, finalPath, 'pack.zip');
  assert.deepStrictEqual(r, { ok: true, contentType: 'application/zip' });
  assert.ok(fs.existsSync(finalPath));
  assert.ok(!fs.existsSync(tmp));
});

test('commitAsset rejects a mislabeled upload and keeps the destination', () => {
  const dir = tmpDir();
  const finalPath = path.join(dir, 'clip.mp4');
  fs.writeFileSync(finalPath, 'previous');
  const tmp = path.join(dir, 'clip.mp4.up-1');
  fs.writeFileSync(tmp, PNG_BYTES);
  const r = assets.commitAsset(tmp, finalPath, 'clip.mp4');
  assert.strictEqual(r.ok, false);
  assert.match(r.error, /does not match/);
  assert.strictEqual(fs.readFileSync(finalPath, 'utf8'), 'previous');
  assert.ok(!fs.existsSync(tmp));
});

test('commitAsset reports unsupported content and cleans up', () => {
  const dir = tmpDir();
  const tmp = path.join(dir, 'x.svg.up-1');
  fs.writeFileSync(tmp, '<svg></svg>');
  const r = assets.commitAsset(tmp, path.join(dir, 'x.svg'), 'x.svg');
  assert.strictEqual(r.ok, false);
  assert.match(r.error, /Unsupported/);
  assert.ok(!fs.existsSync(tmp));
});

test('writeAssetStream accepts an upload with no fixed size cap', async () => {
  const dir = tmpDir();
  const dest = path.join(dir, 'clip.mp4');
  const req = Readable.from([Buffer.alloc(1024), Buffer.alloc(1024)]);
  await assert.doesNotReject(assets.writeAssetStream(req, dest));
  assert.strictEqual(fs.statSync(dest).size, 2048);
});

test('writeAssetStream rejects past maxBytes and removes the partial file', async () => {
  const dir = tmpDir();
  const dest = path.join(dir, 'avatar.png');
  const req = Readable.from([Buffer.alloc(8), Buffer.alloc(8)]);
  await assert.rejects(
    assets.writeAssetStream(req, dest, { maxBytes: 10 }),
    /exceeds the .* limit/,
  );
  assert.ok(!fs.existsSync(dest));
});
