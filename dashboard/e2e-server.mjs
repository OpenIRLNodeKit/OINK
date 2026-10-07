#!/usr/bin/env node
// SPDX-FileCopyrightText: 2026 OpenIRLNodeKit contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
// Minimal foreground HTTP static server for the built SPA, used by Playwright's
// webServer. Serves build/client/ and falls back to index.html for client routes.
import http from 'node:http';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = normalize(fileURLToPath(new URL('./build/client', import.meta.url)));
const PORT = Number(process.argv[2]) || 4399;
const INDEX = join(ROOT, 'index.html');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.woff2': 'font/woff2',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
};

function resolveFile(urlPath) {
  const p = (urlPath || '/').split('?')[0];
  const file = normalize(join(ROOT, decodeURIComponent(p)));
  if (!file.startsWith(ROOT)) return null;
  if (existsSync(file) && statSync(file).isFile()) return file;
  // SPA fallback: any unmatched route serves index.html.
  return existsSync(INDEX) ? INDEX : null;
}

const server = http.createServer((req, res) => {
  const file = resolveFile(req.url);
  if (!file) {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('not found');
    return;
  }
  res.writeHead(200, { 'Content-Type': MIME[extname(file)] || 'application/octet-stream' });
  createReadStream(file).pipe(res);
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[e2e-server] serving build/client/ at http://127.0.0.1:${PORT}`);
});
