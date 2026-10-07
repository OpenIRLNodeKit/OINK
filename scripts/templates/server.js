// SPDX-FileCopyrightText: 2026 OpenIRLNodeKit contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const Busboy = require('busboy');
const GuacamoleLite = require('guacamole-lite');
const Crypt = require('guacamole-lite/lib/Crypt');
const { createTokenService, clientIp } = require('./guac-token');

const CIPHER = 'aes-256-cbc';
const SECRET_KEY = '$GUAC_KEY';
const crypt = new Crypt(CIPHER, SECRET_KEY);

const DEP_DIR = path.join(os.homedir(), 'dependencies');

// The single VNC connection guacd opens for the preview and full remote client.
const VNC_CONNECTION = { type: 'vnc', settings: { hostname: '127.0.0.1', port: 5900 } };

const tokenService = createTokenService({
  encrypt: crypt.encrypt.bind(crypt),
  decrypt: crypt.decrypt.bind(crypt),
});

// ── Dashboard session gate ───────────────────────────────────────────────────
// The remote desktop / preview pages require a dashboard login. Session cookies
// are host-scoped (not port-scoped), so the browser sends the dashboard cookie
// here too; verify it with the stack's own auth module and the same secret.
const STACK_DIR = process.env.OINK_STACK_DIR || path.join(os.homedir(), 'oink', 'stack');

try {
  process.loadEnvFile(path.join(STACK_DIR, 'api.env'));
} catch {
  // api.env isn't provisioned yet (first install: host phase runs before stack).
}
const SESSION_SECRET = process.env.OINK_SESSION_SECRET || '';
// Dashboard port, for redirecting unauthenticated visitors to the login page.
const DASHBOARD_PORT = Number(process.env.OINK_WEB_PORT || 8305);

let accounts = null;
if (SESSION_SECRET) {
  try {
    const { AccountService } = require(path.join(STACK_DIR, 'auth.js'));
    accounts = new AccountService({ stackDir: STACK_DIR, sessionSecret: SESSION_SECRET });
  } catch (e) {
    console.warn('[guac] dashboard auth unavailable, remote pages left ungated:', e.message);
  }
}

// Shared with the dashboard: uploads are validated by content, not file name.
// If it can't load, uploads are refused rather than accepted blindly.
let assets = null;
try {
  assets = require(path.join(STACK_DIR, 'assets.js'));
} catch (e) {
  console.warn('[guac] asset validation unavailable, uploads disabled:', e.message);
}

// Shown in place of a preview when the embedded request has no valid session.
// Never redirect an iframe to the dashboard: :8305 sends frame-ancestors 'none',
// so the browser blocks it with a confusing "another site has embedded it" error.
// This page is same-origin to the iframe and tells the parent (PreviewFrame) to
// show its own "session expired" overlay.
const AUTH_REQUIRED_HTML = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<title>Session expired</title><style>
body{margin:0;height:100vh;display:flex;align-items:center;justify-content:center;
font:14px/1.5 system-ui,-apple-system,sans-serif;background:#18181b;color:#e4e4e7}
.card{text-align:center;padding:24px}.t{font-weight:600;margin:0 0 4px}
.s{color:#a1a1aa;margin:0}</style></head><body><div class="card">
<p class="t">Session expired</p><p class="s">Reload the dashboard and sign in.</p></div>
<script>try{parent.postMessage({type:'oink-auth-required'},'*')}catch(e){}</script>
</body></html>`;

function isEmbedded(req) {
  return String(req.headers['sec-fetch-dest'] || '') === 'iframe';
}

function requireAuth(req, res) {
  if (!accounts) return true;
  if (accounts.currentUser(req)) return true;
  if (isEmbedded(req)) {
    res.writeHead(401, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(AUTH_REQUIRED_HTML);
    return false;
  }
  // Send a cold visitor to the dashboard login rather than a dead-end 401.
  const host = String(req.headers.host || '').replace(/:\d+$/, '');
  res.writeHead(302, { Location: `http://${host}:${DASHBOARD_PORT}/` });
  res.end();
  return false;
}

// Read a page template and inject a fresh token bound to the requesting client.
function renderPage(file, req) {
  return fs
    .readFileSync(path.join(__dirname, file), 'utf8')
    .replace('__GUAC_TOKEN__', tokenService.mint(VNC_CONNECTION, clientIp(req)))
    .replace('__DEP_DIR__', DEP_DIR);
}

function ensureDepDir() {
  if (!fs.existsSync(DEP_DIR)) fs.mkdirSync(DEP_DIR, { recursive: true });
}

function sendJson(res, code, payload) {
  res.writeHead(code, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(payload));
}

// Log the underlying cause server-side (it may contain paths/stack details) but
// return only a generic message to the client so internals are not leaked.
function sendServerError(res, e, generic) {
  console.error('[server] ' + generic + ':', e);
  sendJson(res, 500, { error: generic });
}

const MIME = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml',
  '.bmp': 'image/bmp', '.ico': 'image/x-icon', '.tif': 'image/tiff',
  '.tiff': 'image/tiff', '.avif': 'image/avif',
  '.mp4': 'video/mp4', '.mov': 'video/quicktime', '.mkv': 'video/x-matroska',
  '.webm': 'video/webm', '.avi': 'video/x-msvideo', '.m4v': 'video/x-m4v',
  '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.ogg': 'audio/ogg',
  '.m4a': 'audio/mp4', '.flac': 'audio/flac', '.aac': 'audio/aac',
  '.pdf': 'application/pdf',
  '.zip': 'application/zip', '.tar': 'application/x-tar',
  '.gz': 'application/gzip', '.7z': 'application/x-7z-compressed',
  '.rar': 'application/vnd.rar',
  '.txt': 'text/plain', '.md': 'text/markdown', '.log': 'text/plain',
  '.json': 'application/json', '.xml': 'application/xml', '.csv': 'text/csv',
  '.html': 'text/html', '.htm': 'text/html', '.css': 'text/css',
  '.js': 'application/javascript', '.mjs': 'application/javascript',
  '.mpd': 'application/dash+xml'
};

function mimeType(name) {
  const ext = path.extname(name).toLowerCase();
  return MIME[ext] || 'application/octet-stream';
}

function handleApi(req, res) {
  const url = new URL(req.url, 'http://localhost');

  // GET /api/files — list files
  if (req.method === 'GET' && url.pathname === '/api/files') {
    ensureDepDir();
    try {
      const files = fs.readdirSync(DEP_DIR, { withFileTypes: true })
        .filter(d => d.isFile() && !d.name.includes('.up-'))
        .map(d => {
          const st = fs.statSync(path.join(DEP_DIR, d.name));
          return { name: d.name, size: st.size, mtime: st.mtimeMs };
        })
        .sort((a, b) => a.name.localeCompare(b.name));
      sendJson(res, 200, { files });
    } catch (e) {
      sendServerError(res, e, 'Failed to list files');
    }
    return;
  }

  // GET /api/download?name=<name>[&inline=1] — download a file as-is
  if (req.method === 'GET' && url.pathname === '/api/download') {
    const name = url.searchParams.get('name');
    if (!name) return sendJson(res, 400, { error: 'missing name' });
    if (!/^[^/\\]+$/.test(name)) return sendJson(res, 400, { error: 'invalid name' });
    const fp = path.join(DEP_DIR, name);
    if (!fp.startsWith(DEP_DIR)) return sendJson(res, 400, { error: 'invalid name' });
    ensureDepDir();
    try {
      if (!fs.existsSync(fp)) return sendJson(res, 404, { error: 'not found' });
      const st = fs.statSync(fp);
      const type = mimeType(name);
      // Only serve a validated media file inline (thumbnails/playback); anything
      // else — including legacy HTML/SVG already on disk — is forced to download,
      // so it can never execute same-origin against the dashboard session.
      let inline = false;
      if (url.searchParams.has('inline') && assets) {
        try { inline = Boolean(assets.sniffAssetType(fp)); } catch { inline = false; }
      }
      const headers = {
        'Content-Type': type,
        'Content-Length': st.size,
        'X-Content-Type-Options': 'nosniff',
      };
      if (!inline) {
        headers['Content-Disposition'] =
          'attachment; filename="' + name.replace(/"/g, '') + '"';
      }
      res.writeHead(200, headers);
      fs.createReadStream(fp).pipe(res);
    } catch (e) {
      sendServerError(res, e, 'Failed to read file');
    }
    return;
  }

  // DELETE /api/files?name=<name> — delete a file
  if (req.method === 'DELETE' && url.pathname === '/api/files') {
    const name = url.searchParams.get('name');
    if (!name) return sendJson(res, 400, { error: 'missing name' });
    if (!/^[^/\\]+$/.test(name)) return sendJson(res, 400, { error: 'invalid name' });
    const fp = path.join(DEP_DIR, name);
    if (!fp.startsWith(DEP_DIR)) return sendJson(res, 400, { error: 'invalid name' });
    try {
      if (fs.existsSync(fp)) fs.unlinkSync(fp);
      sendJson(res, 200, { ok: true });
    } catch (e) {
      sendServerError(res, e, 'Failed to delete file');
    }
    return;
  }

  // POST /api/upload — multipart file upload. Content is validated by
  // stack/assets.js (same rule as the dashboard): PNG/JPEG/GIF/WebP images,
  // video, and audio only. No size cap.
  if (req.method === 'POST' && url.pathname === '/api/upload') {
    ensureDepDir();
    if (!assets) {
      return sendJson(res, 503, { error: 'Uploads unavailable (asset validation not loaded)' });
    }
    let busboy;
    try {
      busboy = Busboy({ headers: req.headers });
    } catch (e) {
      console.error('[server] Invalid upload request:', e);
      return sendJson(res, 400, { error: 'Invalid upload request' });
    }
    const saved = [];
    const errors = [];
    let pending = 0;
    let parsed = false;

    const done = () => {
      if (parsed && pending === 0) {
        sendJson(res, 200, { ok: errors.length === 0, saved, errors, dir: DEP_DIR });
      }
    };

    busboy.on('file', (fieldname, file, info) => {
      pending += 1;
      let name;
      try {
        name = assets.sanitizeAssetName(info.filename);
      } catch (e) {
        errors.push(`${info.filename}: ${e.message}`);
        file.resume();
        pending -= 1;
        return done();
      }
      const finalPath = path.join(DEP_DIR, name);
      const tmpPath = `${finalPath}.up-${process.pid}-${Date.now()}-${pending}`;
      const ws = fs.createWriteStream(tmpPath);
      ws.on('finish', () => {
        const r = assets.commitAsset(tmpPath, finalPath, name);
        if (r.ok) saved.push(name); else errors.push(r.error);
        pending -= 1;
        done();
      });
      ws.on('error', () => {
        try { fs.unlinkSync(tmpPath); } catch {}
        errors.push(`${name}: write failed`);
        pending -= 1;
        done();
      });
      file.pipe(ws);
    });

    busboy.on('error', e => { console.error('[server] Upload error:', e); });
    busboy.on('finish', () => { parsed = true; done(); });

    req.pipe(busboy);
    return;
  }

  sendJson(res, 404, { error: 'not found' });
}

new GuacamoleLite(
  {
    port: 8080,
    // Loopback only: the browser reaches this through nginx (same-origin
    // /guacws/), so there is no reason to expose the tunnel on the network.
    host: '127.0.0.1',
    // Reject the WS upgrade unless the token is fresh, unused, and from the same
    // client IP it was minted to.
    verifyClient: (info, cb) => {
      try {
        const token = new URL(info.req.url, 'http://localhost').searchParams.get('token');
        const reason = tokenService.verify(token, clientIp(info.req));
        if (reason) {
          console.warn('[guac] rejected websocket:', reason);
          cb(false, 401, 'Unauthorized');
          return;
        }
        cb(true);
      } catch {
        cb(false, 401, 'Unauthorized');
      }
    },
  },
  { host: '127.0.0.1', port: 4822 },
  { crypt: { cypher: CIPHER, key: SECRET_KEY } }
);

http.createServer((req, res) => {
  const pathname = req.url.split('?')[0];
  if (pathname === '/guac.js') {
    res.writeHead(200, { 'Content-Type': 'application/javascript' });
    res.end(fs.readFileSync(__dirname + '/lib/guac.min.js'));
    return;
  }
  // Session probe for the /remote page's poll. Deliberately before the auth gate:
  // it reports "not signed in" instead of redirecting, so the client can decide to
  // drop its WebSocket. Mirrors the dashboard's /api/auth/status shape.
  if (pathname === '/auth-status') {
    const enabled = Boolean(accounts && accounts.enabled);
    sendJson(res, 200, { ok: enabled && Boolean(accounts.currentUser(req)), enabled });
    return;
  }
  if (pathname === '/preview') {
    if (!requireAuth(req, res)) return;
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(renderPage('preview-client.html', req));
    return;
  }
  if (pathname === '/preview-dashboard') {
    if (!requireAuth(req, res)) return;
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(renderPage('preview-dashboard.html', req));
    return;
  }
  if (pathname.startsWith('/api/')) {
    if (!requireAuth(req, res)) return;
    handleApi(req, res);
    return;
  }
  if (!requireAuth(req, res)) return;
  res.writeHead(200, { 'Content-Type': 'text/html' });
  res.end(renderPage('client.html', req));
// Loopback only: nginx proxies these pages same-origin; the browser never
// connects to :8081 directly.
}).listen(8081, '127.0.0.1');

console.log('tunnel on :8080 \u00b7 page on :8081 \u00b7 deps in ' + DEP_DIR);
