#!/usr/bin/env node
// SPDX-FileCopyrightText: 2026 OpenIRLNodeKit contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * log-server.js — API server for the OINK control plane.
 *
 *  * WebSocket log streaming (journalctl + OBS tail)
 *  * Start/stop/restart the native oink-* systemd services
 *  * Read/write config files
 *
 * Runs on the host as the runtime user (oink-api.service). Service control is
 * scoped to the allowlisted units below; log reads use journalctl, which the
 * runtime user can do via the systemd-journal group (see the polkit rule
 * oink-service-control.rules).
 *
 * Usage: node log-server.js [port]
 * Default port: 8082 (bound to 127.0.0.1 unless API_BIND_HOST is set)
 */

const http = require('http');
const { execFileSync, spawn } = require('child_process');
const { WebSocket, WebSocketServer } = require('ws');
const fs = require('fs');
const os = require('os');
const path = require('path');
const url = require('url');
const { AccountService, ROLES, canReadLogStream } = require('./auth');
const ingest = require('./ingest');
const dashboardSettings = require('./settings');
const backup = require('./backup');
const logs = require('./logs');
const { trustEnabled, clientIpFor } = require('./proxy');
const { isUnsafeMethod, checkOrigin, checkCsrf } = require('./csrf');
const status = require('./status');
const { InputError, BusyError } = require('./errors');
const { CONFIG_FILES, validateConfig, redactConfig, restoreConfigSecrets, setNoalbsChannel, pinNoalbsChannel } = require('./config');
const {
  AVATAR_DIR, AVATAR_MAX_BYTES, sanitizeAssetName,
  mimeForAsset, writeAssetStream, assertContained, avatarPath, sniffAvatarType,
  sniffAssetType, commitAsset,
} = require('./assets');
const {
  OBS_RECORDING_DIR, isRecordingName, recordingThumbPath,
  ensureRecordingThumb, serveFileWithRange,
} = require('./recordings');
const {
  OBS_PLUGIN_DIR, PLUGIN_UPLOAD_MAX_BYTES, DEFAULT_PLUGINS, defaultPlugin,
  pluginInstalled, pluginLoaded, _downloadFile, _sha256File,
  _installPluginArchive, _installPluginDeb,
} = require('./plugins');
const {
  ensureObs, _getPrimaryPlatform, listScenes, getCurrentScene, switchScene,
  getObsVersion,
  getStreamSettings, setStreamSettings, validateStreamSettings,
  provisionMediaSource, deleteMediaSource, provisionBrowserSource, deleteBrowserSource,
  getIngestControls, setIngestMute, setIngestVisible, restartIngestSource,
  getPrimaryPlatform, setPrimaryPlatform, getStreamService, setStreamServiceKey,
  readMultistreamConfig, multistreamKeyState, applyMultistreamKeys, removePlatformFromMultistream,
  writeMultistreamConfig,
  startStream, stopStream, getStreamStatus,
  startRecording, stopRecording, getRecordingStatus,
  startVirtualCam, stopVirtualCam,
  MULTISTREAM_PLATFORMS, PLATFORMS,
} = require('./obs-bridge');
const vcamState = require('./vcam-state');

const PORT = parseInt(process.argv[2] || '8082', 10);
const API_BIND_HOST = process.env.API_BIND_HOST || '127.0.0.1';
// Allowlisted systemd units the dashboard may start/stop/restart. The polkit
// rule grants obsuser exactly these verbs on exactly these units — never widen
// this without updating oink-service-control.rules too.
const CTRL_UNITS = {
  mediamtx: 'oink-mediamtx',
  noalbs: 'oink-noalbs',
  obs: 'oink-obs',
};
const OBS_LOG_DIR = process.env.OBS_LOG_DIR || '/obs-logs';
const OBS_ASSET_DIR = process.env.OBS_ASSET_DIR || '/obs-assets';
const STACK_DIR = process.env.OINK_STACK_DIR || __dirname;

// Dashboard preview: OBS writes its program output to the v4l2loopback device;
// ffmpeg reads it back and we re-serve MJPEG same-origin for the dashboard's
// <img>. Overridable so a test host can point at a different /dev/videoN.
const PREVIEW_DEVICE = process.env.OINK_PREVIEW_DEVICE || '/dev/video0';
const PREVIEW_BOUNDARY = 'oinkframe';
// The preview is a monitor, not a recording: downscale, cap fps, and use a
// cheaper JPEG so one encoder costs a fraction of a core and a few Mbps
// instead of a full core and ~125 Mbps at full 1080p30. Env-overridable so a
// box can be retuned without redeploying.
const PREVIEW_WIDTH = Number(process.env.OINK_PREVIEW_WIDTH) || 1280;
const PREVIEW_FPS = Number(process.env.OINK_PREVIEW_FPS) || 15;
const PREVIEW_QUALITY = Number(process.env.OINK_PREVIEW_QUALITY) || 8;

// Upper bound for a JSON request body (config writes and OBS control payloads
// are tiny; this only stops unbounded memory growth on the control endpoints).
const JSON_MAX_BYTES = 1024 * 1024;

// Origins permitted to call this API from a browser. The web UI is served same-origin
// via Nginx (relative /api/* paths) so no Origin header is sent for it. Leave empty to
// deny ALL cross-origin browser access; add comma-separated origins if a tool needs it.
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

// ── Rate limiting ───────────────────────────────────────────────────────
// Per-key sliding-window limit (IP, or IP+route for login) so the auth
// endpoint and the control plane aren't open to brute force / abuse.
const RATE_LIMIT = {
  default: { limit: 240, windowMs: 60000 },
  login: { limit: 10, windowMs: 60000 },
};
const _hits = new Map();
function rateLimit(req, res, bucketKey, opts) {
  const { limit, windowMs } = opts;
  const now = Date.now();
  const start = Math.floor(now / windowMs) * windowMs;
  const key = `${bucketKey}`;
  const bucket = _hits.get(key);
  if (!bucket || bucket.start !== start) {
    _hits.set(key, { start, count: 1 });
    // Evict previous-window buckets so a flood of distinct client IPs (each a
    // silent XFF->bucket) can't grow the map without bound.
    if (_hits.size > 10_000) {
      for (const [k, b] of _hits) if (b.start !== start) _hits.delete(k);
    }
    return true;
  }
  bucket.count += 1;
  if (bucket.count > limit) {
    sendError(res, 429, 'Too many requests — retry shortly');
    return false;
  }
  return true;
}

// --- Control-plane auth (accounts + roles) ---
//
// Enforced only when OINK_ADMIN_PASSWORD and OINK_SESSION_SECRET are set: the
// stack phase provisions both into ~/oink/stack/api.env (0600), loaded by
// oink-api.service via EnvironmentFile. With neither set (local dev / mocked
// Playwright server) every request is treated as a local admin, so the auth
// flow does not change its shape.
// OINK_TRUSTED_PROXIES signals that a fronting proxy (own TLS terminator /
// Cloudflare Tunnel) sits in front of nginx: the real client IP then arrives in
// X-Forwarded-For and the session cookie is marked Secure. Unset = unchanged.
const TRUST_PROXY = trustEnabled(process.env.OINK_TRUSTED_PROXIES);
const accounts = new AccountService({
  stackDir: STACK_DIR,
  sessionSecret: process.env.OINK_SESSION_SECRET || '',
  adminPassword: process.env.OINK_ADMIN_PASSWORD || '',
  adminPasswordOrigin: process.env.OINK_ADMIN_PASSWORD_ORIGIN || 'generated',
  secureCookies: TRUST_PROXY,
});
const AUTH_ENABLED = accounts.enabled;
// Present-but-broken auth config: accounts/secret exist but sessions can't be
// verified. Fail closed (503) rather than serving an unauthenticated local admin.
const AUTH_MISCONFIGURED = accounts.misconfigured === true;
const LOCAL_USER = { id: 'local', username: 'local', role: ROLES.ADMIN };

// Routes a must-change user may still reach. Everything else returns 403 until
// they have rotated their password (see mustChangeLock in requireRole below).
const MUST_CHANGE_OK = new Set([
  '/api/auth/password',
  '/api/auth/status',
  '/api/auth/logout',
]);

function currentUser(req) {
  if (AUTH_MISCONFIGURED) return null;
  if (!AUTH_ENABLED) return { ...LOCAL_USER };
  return accounts.currentUser(req);
}

function requireRole(req, res, roles) {
  const user = currentUser(req);
  if (!user) {
    sendError(res, 401, 'Unauthorized');
    return null;
  }
  if (user.mustChangePassword && !MUST_CHANGE_OK.has(req.url.split('?')[0])) {
    sendError(res, 403, 'Password change required');
    return null;
  }
  if (!roles.includes(user.role)) {
    sendError(res, 403, 'Forbidden');
    return null;
  }
  return user;
}

function auditReq(user, msg) {
  console.log(`[log-server] ${msg} by ${user ? `${user.username}@${user.role}` : '?'}`);
}

const server = http.createServer(async (req, res) => {
  const parsed = url.parse(req.url, true);
  const pathname = parsed.pathname;

  // CORS: the web UI reaches this API same-origin via Nginx (relative /api/* paths).
  // No cross-origin browser calls are expected, so do NOT echo a wildcard origin on a
  // server that triggers service start/stop/restart. Only allow explicit known origins.
  const origin = req.headers.origin;
  if (origin && ALLOWED_ORIGINS.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-CSRF-Token');

  if (req.method === 'OPTIONS') {
    json(res, origin && ALLOWED_ORIGINS.includes(origin) ? 204 : 403, {
      ok: false,
      error: 'Origin not allowed',
    });
    return;
  }

  // Rate limit every /api/* call (OPTIONS handled above) by caller IP. The tight
  // login-specific bucket is applied inside the login route.
  const clientIp = clientIpFor(req);
  if (pathname.startsWith('/api/')) {
    if (!rateLimit(req, res, `api:${clientIp}`, RATE_LIMIT.default)) return;
  }

  // Health
  if (pathname === '/health') {
    json(res, 200, { ok: true });
    return;
  }

  // Auth is configured but unusable (missing session secret while accounts
  // exist). Refuse the whole API instead of falling open to a local admin.
  if (AUTH_MISCONFIGURED && pathname.startsWith('/api/')) {
    return sendError(res, 503, 'Authentication is misconfigured — restore OINK_SESSION_SECRET in api.env and restart');
  }

  // CSRF: reject state-changing calls that did not originate from the dashboard.
  // SameSite=Strict already blocks cross-site cookie attachment; this is the
  // second layer. Origin/Referer host must match ours, and (except for login,
  // which bootstraps the session) the X-CSRF-Token header must match the token
  // signed into the session. Skipped entirely when auth is disabled (local dev /
  // mocked Playwright server), where no session exists to protect.
  if (AUTH_ENABLED && isUnsafeMethod(req.method)) {
    if (!checkOrigin(req)) {
      return sendError(res, 403, 'Cross-origin request refused');
    }
    if (pathname !== '/api/auth/login') {
      const expected = accounts.csrfFor(req);
      if (!expected || !checkCsrf(req, expected)) {
        return sendError(res, 403, 'Invalid CSRF token');
      }
    }
  }

  // --- Auth: login / status / logout, then gate every remaining /api/* call ---

  // POST /api/auth/login {username, password} — sets an HttpOnly session cookie.
  if (pathname === '/api/auth/login' && req.method === 'POST') {
    if (!rateLimit(req, res, `login:${clientIp}`, RATE_LIMIT.login)) return;
    let username = '';
    let password = '';
    try {
      const body = JSON.parse(await readBody(req));
      username = String(body.username || '');
      password = String(body.password || '');
    } catch {
      return sendError(res, 400, 'Request body must be valid JSON');
    }
    if (!AUTH_ENABLED) {
      return json(res, 200, { ok: true, enabled: false });
    }
    const user = accounts.authenticate(username, password);
    if (!user) {
      return sendError(res, 401, 'Invalid username or password');
    }
    accounts.issueSession(user, res);
    return json(res, 200, { ok: true, enabled: true, user });
  }

  // GET /api/auth/status — lets the UI decide whether to require a login and
  // which role the signed-in user holds.
  if (pathname === '/api/auth/status' && req.method === 'GET') {
    const user = AUTH_ENABLED ? accounts.currentUser(req) : null;
    return json(res, 200, {
      ok: AUTH_ENABLED ? Boolean(user) : false,
      enabled: AUTH_ENABLED,
      user,
    });
  }

  // POST /api/auth/logout — clears the session cookie (stateless tokens expire
  // at their TTL; there is no server-side revocation list to purge).
  if (pathname === '/api/auth/logout' && req.method === 'POST') {
    accounts.endSession(req, res);
    return json(res, 200, { ok: true });
  }

  // POST /api/auth/password  {oldPassword, newPassword} — rotate your own.
  if (pathname === '/api/auth/password' && req.method === 'POST') {
    const user = requireRole(req, res, [ROLES.ADMIN, ROLES.OPERATOR, ROLES.VIEWER]);
    if (!user) return;
    try {
      const { oldPassword, newPassword } = await readJson(req);
      accounts.changePassword(user.username, String(oldPassword || ''), String(newPassword || ''));
      // changePassword bumps the session version, revoking every outstanding
      // token — including this tab's. Deliberately does not re-issue: changing a
      // password signs you out everywhere and prompts a fresh sign-in.
      auditReq(user, 'password change');
      return json(res, 200, { ok: true, message: 'Password updated' });
    } catch (e) {
      return sendError(res, 400, e.message);
    }
  }

  // Admin-only: user management.

  // GET /api/auth/users — list users (never returns password hashes).
  if (pathname === '/api/auth/users' && req.method === 'GET') {
    const user = requireRole(req, res, [ROLES.ADMIN]);
    if (!user) return;
    return json(res, 200, { ok: true, users: accounts.listUsers() });
  }

  // POST /api/auth/users  {username, role, password} — create a user.
  if (pathname === '/api/auth/users' && req.method === 'POST') {
    const user = requireRole(req, res, [ROLES.ADMIN]);
    if (!user) return;
    try {
      const { username, role, password } = await readJson(req);
      const created = accounts.createUser({ username, role, password });
      auditReq(user, `user create ${created.username} (${created.role})`);
      return json(res, 200, { ok: true, user: created });
    } catch (e) {
      return sendError(res, 400, e.message);
    }
  }

  // POST /api/auth/users/:name/reset  {password} — set a user's password.
  const userResetMatch = pathname.match(/^\/api\/auth\/users\/([^/]+)\/reset$/);
  if (userResetMatch && req.method === 'POST') {
    const user = requireRole(req, res, [ROLES.ADMIN]);
    if (!user) return;
    try {
      const { password } = await readJson(req);
      accounts.resetPassword(decodeURIComponent(userResetMatch[1]), password);
      auditReq(user, `user password reset ${decodeURIComponent(userResetMatch[1])}`);
      return json(res, 200, { ok: true, message: 'Password reset' });
    } catch (e) {
      return sendError(res, 400, e.message);
    }
  }

  // POST /api/auth/users/:name/disabled  {disabled} — enable/disable a user.
  const userDisableMatch = pathname.match(/^\/api\/auth\/users\/([^/]+)\/disabled$/);
  if (userDisableMatch && req.method === 'POST') {
    const user = requireRole(req, res, [ROLES.ADMIN]);
    if (!user) return;
    try {
      const { disabled } = await readJson(req);
      accounts.setUserDisabled(decodeURIComponent(userDisableMatch[1]), Boolean(disabled));
      auditReq(user, `user ${disabled ? 'disabled' : 'enabled'}` +
        ` ${decodeURIComponent(userDisableMatch[1])}`);
      return json(res, 200, { ok: true });
    } catch (e) {
      return sendError(res, 400, e.message);
    }
  }

  // --- Profile avatars (per-user, stored on the box) ---
  // POST /api/auth/avatar — raw image body. Magic bytes decide the content type
  //   (never trusts the client's MIME), so SVG/HTML/etc. are rejected outright.
  //   File lives at stack assets/avatars/{user.id}; the store records the type.
  // GET  /api/auth/avatar — current user's image, inline (the header <img> loads
  //   it same-origin with the session cookie; ?v= cache-busts).
  // DELETE /api/auth/avatar — removes the image and the store entry.
  if (pathname === '/api/auth/avatar' && req.method === 'POST') {
    const user = requireRole(req, res, [ROLES.ADMIN, ROLES.OPERATOR, ROLES.VIEWER]);
    if (!user) return;
    if (!AUTH_ENABLED) return sendError(res, 404, 'Not found');
    // Stage to a temp file first: a rejected upload must never clobber the
    // user's current avatar, which lives at the fixed {user.id} path.
    const filePath = avatarPath(user.id);
    const tmpPath = `${filePath}.up-${process.pid}-${Date.now()}`;
    try {
      fs.mkdirSync(AVATAR_DIR, { recursive: true });
      await writeAssetStream(req, tmpPath, AVATAR_MAX_BYTES);
      const contentType = sniffAvatarType(tmpPath);
      if (!contentType) {
        fs.unlinkSync(tmpPath);
        return sendError(res, 400, 'Avatar must be a PNG, JPEG, WebP, or GIF image');
      }
      fs.renameSync(tmpPath, filePath);
      const updated = accounts.setAvatar(user.username, { contentType });
      auditReq(user, `set profile avatar`);
      return json(res, 200, { ok: true, user: updated });
    } catch (e) {
      try { fs.unlinkSync(tmpPath); } catch {}
      if (e instanceof InputError) {
        return sendError(res, 413, e.message);
      }
      return sendServerError(res, 500, e, 'Failed to save avatar');
    }
  }

  if (pathname === '/api/auth/avatar' && req.method === 'GET') {
    const user = requireRole(req, res, [ROLES.ADMIN, ROLES.OPERATOR, ROLES.VIEWER]);
    if (!user || !AUTH_ENABLED) return sendError(res, 404, 'Not found');
    const meta = accounts.getAvatar(user.username);
    const filePath = avatarPath(user.id);
    if (!meta || !fs.existsSync(filePath)) {
      return sendError(res, 404, 'No avatar set');
    }
    try {
      assertContained(filePath, AVATAR_DIR);
    } catch (e) {
      return sendError(res, 400, e.message);
    }
    try {
      res.writeHead(200, {
        'Content-Type': meta.contentType,
        'Content-Length': fs.statSync(filePath).size,
        'Content-Disposition': 'inline',
        'X-Content-Type-Options': 'nosniff',
        'Cache-Control': 'no-cache',
      });
      fs.createReadStream(filePath).pipe(res);
    } catch (e) {
      return sendServerError(res, 500, e, 'Failed to read avatar');
    }
    return;
  }

  if (pathname === '/api/auth/avatar' && req.method === 'DELETE') {
    const user = requireRole(req, res, [ROLES.ADMIN, ROLES.OPERATOR, ROLES.VIEWER]);
    if (!user) return;
    if (!AUTH_ENABLED) return sendError(res, 404, 'Not found');
    const filePath = avatarPath(user.id);
    try {
      assertContained(filePath, AVATAR_DIR);
    } catch (e) {
      return sendError(res, 400, e.message);
    }
    try {
      try { fs.unlinkSync(filePath); } catch {}
      const updated = accounts.clearAvatar(user.username);
      auditReq(user, `removed profile avatar`);
      return json(res, 200, { ok: true, user: updated });
    } catch (e) {
      return sendServerError(res, 500, e, 'Failed to remove avatar');
    }
  }

  // Catch-all gate for every remaining route. Also applies the forced first-login
  // lockdown: a must-change account gets 403 on all of these (GETs included) —
  // only the password flow above this point is reachable until it rotates.
  const gateUser = currentUser(req);
  if (!gateUser) {
    sendError(res, 401, 'Unauthorized');
    return;
  }
  if (gateUser.mustChangePassword) {
    sendError(res, 403, 'Password change required');
    return;
  }

  // --- Service control (native systemd units) ---

  // GET /api/service/:name/status
  const serviceMatch = pathname.match(/^\/api\/service\/(\w+)\/status$/);
  if (serviceMatch && req.method === 'GET') {
    const name = serviceMatch[1];
    const unit = serviceUnit(name);
    if (!unit) {
      json(res, 200, { running: false, name });
      return;
    }
    let state = 'inactive';
    try {
      state = systemctl('is-active', unit, { timeout: 5000 }).trim();
    } catch (e) {
      // is-active prints the state on stdout and exits non-zero when not active.
      state = String(e?.stdout ?? 'inactive').trim() || 'inactive';
    }
    json(res, 200, { running: state === 'active', status: state, unit, name });
    return;
  }

  // POST /api/service/:name/{start,stop,restart}
  const actionMatch = pathname.match(/^\/api\/service\/(\w+)\/(start|stop|restart)$/);
  if (actionMatch && req.method === 'POST') {
    const user = requireRole(req, res, [ROLES.ADMIN, ROLES.OPERATOR]);
    if (!user) return;
    const name = actionMatch[1];
    const action = actionMatch[2];
    const unit = serviceUnit(name);
    if (!unit) {
      sendError(res, 404, `Unknown service: ${name}`);
      return;
    }
    const past = { start: 'started', stop: 'stopped', restart: 'restarted' }[action];
    try {
      // NOALBS reads its config at startup, so bring the monitored feed's
      // statsUrl up to date before it (re)starts.
      if (name === 'noalbs' && action !== 'stop') {
        ingest.setNoalbsMain(STACK_DIR, ingest.readProfileState(STACK_DIR).main);
      }
      systemctl(action, unit, { timeout: 30000 });
      auditReq(user, `service ${action} ${name}`);
      json(res, 200, { ok: true, message: `${name} ${past}` });
    } catch (e) {
      sendServerError(res, 500, e, `Failed to ${action} ${name}`);
    }
    return;
  }

  // --- Backup / restore (admin only) ---

  const backupOpts = () => ({
    assets: parsed.query.assets === '1',
    recordings: parsed.query.recordings === '1',
  });

  // GET /api/backup/size?assets=&recordings= — pre-download estimate.
  if (pathname === '/api/backup/size' && req.method === 'GET') {
    const user = requireRole(req, res, [ROLES.ADMIN]);
    if (!user) return;
    try {
      json(res, 200, { ok: true, ...backup.stats(backupOpts()) });
    } catch (e) {
      sendServerError(res, 500, e, 'Failed to size the backup');
    }
    return;
  }

  // GET /api/backup?assets=&recordings= — stream a .zip download.
  if (pathname === '/api/backup' && req.method === 'GET') {
    const user = requireRole(req, res, [ROLES.ADMIN]);
    if (!user) return;
    let made;
    try {
      made = backup.createArchive({ ...backupOpts(), channel: parsed.query.channel });
    } catch (e) {
      if (e instanceof InputError) return sendError(res, 400, e.message);
      return sendServerError(res, 500, e, 'Failed to create the backup');
    }
    auditReq(user, `backup download (${made.count} files)`);
    const filename = path.basename(made.file);
    res.writeHead(200, {
      'Content-Type': 'application/zip',
      'Content-Length': fs.statSync(made.file).size,
      'Content-Disposition': `attachment; filename="${filename.replace(/"/g, '')}"`,
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    });
    const cleanup = () => fs.rmSync(made.dir, { recursive: true, force: true });
    const stream = fs.createReadStream(made.file);
    stream.on('error', (e) => {
      cleanup();
      if (!res.headersSent) sendServerError(res, 500, e, 'Failed to stream the backup');
      else res.destroy();
    });
    stream.on('close', cleanup);
    res.on('close', cleanup);
    stream.pipe(res);
    return;
  }

  // POST /api/backup/restore — upload an archive and apply the dashboard-safe
  // subset. api.env is skipped (needs root-level unit restarts); see the note
  // in the response so the operator can run `sudo oink restore` for full fidelity.
  if (pathname === '/api/backup/restore' && req.method === 'POST') {
    const user = requireRole(req, res, [ROLES.ADMIN]);
    if (!user) return;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oink-upload-'));
    const file = path.join(dir, 'upload.zip');
    try {
      await writeAssetStream(req, file, backup.MAX_ARCHIVE_BYTES);
    } catch (e) {
      fs.rmSync(dir, { recursive: true, force: true });
      if (e instanceof InputError) return sendError(res, 400, e.message);
      return sendServerError(res, 500, e, 'Failed to receive the backup');
    }

    let info;
    try {
      info = backup.inspectArchive(file);
    } catch (e) {
      fs.rmSync(dir, { recursive: true, force: true });
      if (e instanceof InputError) return sendError(res, 400, e.message);
      return sendServerError(res, 500, e, 'Failed to read the backup');
    }

    const wasActive = (unit) => {
      try {
        return systemctl('is-active', unit, { timeout: 5000 }).trim() === 'active';
      } catch (e) {
        return String(e?.stdout ?? '').trim() === 'active';
      }
    };
    const affected = [];
    if (info.touched.obs) affected.push('oink-obs');
    if (info.touched.mediamtx) affected.push('oink-mediamtx');
    if (info.touched.noalbs) affected.push('oink-noalbs');
    const active = affected.filter(wasActive);

    let result;
    try {
      for (const unit of active) {
        try { systemctl('stop', unit, { timeout: 30000 }); } catch { /* best effort */ }
      }
      result = await backup.restoreArchive(file);
    } catch (e) {
      if (e instanceof InputError) return sendError(res, 400, e.message);
      return sendServerError(res, 500, e, 'Failed to restore the backup');
    } finally {
      for (const unit of active) {
        try { systemctl('start', unit, { timeout: 30000 }); } catch { /* best effort */ }
      }
      fs.rmSync(dir, { recursive: true, force: true });
    }

    auditReq(user, `backup restore (${result.restored.length} files)`);
    json(res, 200, {
      ok: true,
      restored: result.restored,
      skipped: result.skipped,
      failed: result.failed,
      restarted: active,
      note: result.skipped.length
        ? 'api.env skipped — run `sudo oink restore <file>` for secrets/session state.'
        : '',
    });
    return;
  }

  // --- Config files ---

  // GET /api/config/:service
  const configGetMatch = pathname.match(/^\/api\/config\/(\w+)$/);
  if (configGetMatch && req.method === 'GET') {
    const user = requireRole(req, res, [ROLES.ADMIN]);
    if (!user) return;
    const service = configGetMatch[1];
    const configFile = CONFIG_FILES[service];
    if (!configFile || !fs.existsSync(configFile)) {
      sendError(res, 404, `Config for ${service} not found`);
      return;
    }
    try {
      // Redact secrets on read so a live credential (e.g. noalbs software.password,
      // the mediamtx ingest key) never leaves the server in plaintext.
      const content = redactConfig(service, fs.readFileSync(configFile, 'utf-8'));
      json(res, 200, { ok: true, content, file: path.basename(configFile) });
    } catch (e) {
      sendServerError(res, 500, e, `Failed to read config for ${service}`);
    }
    return;
  }

  // PUT /api/config/:service
  const configPutMatch = pathname.match(/^\/api\/config\/(\w+)$/);
  if (configPutMatch && req.method === 'PUT') {
    const user = requireRole(req, res, [ROLES.ADMIN]);
    if (!user) return;
    const service = configPutMatch[1];
    const configFile = CONFIG_FILES[service];
    if (!configFile) {
      sendError(res, 404, `Config for ${service} not found`);
      return;
    }

    let content;
    try {
      ({ content } = await readJson(req));
    } catch (e) {
      return sendError(res, 400, e.message);
    }
    if (typeof content !== 'string' || !content.trim()) {
      return sendError(res, 400, 'content must be a non-empty string');
    }
    let restored;
    try {
      // Restore any redacted secret placeholder from the on-disk file before write
      // so an edit that doesn't touch a secret never clobbers it with the marker.
      restored = restoreConfigSecrets(service, content);
      // The channel is dashboard-owned; a whole-file config save must not revert
      // NOALBS' chat.username to a stale value (see setNoalbsChannel).
      if (service === 'noalbs') {
        const ch = dashboardSettings.readSettings(STACK_DIR).twitchChannel;
        restored = pinNoalbsChannel(restored, ch);
      }
      validateConfig(service, restored);
    } catch (e) {
      // Validation messages are user-facing (the editor shows data.error).
      return sendError(res, 400, e.message);
    }

    try {
      // Backup current config
      if (fs.existsSync(configFile)) {
        fs.copyFileSync(configFile, configFile + '.bak');
        fs.chmodSync(configFile + '.bak', 0o600);
      }
      fs.writeFileSync(configFile, restored, 'utf-8');
      // config files hold secrets (noalbs software.password); keep them 0600.
      fs.chmodSync(configFile, 0o600);
    } catch (e) {
      return sendServerError(res, 500, e, `Failed to write config for ${service}`);
    }

    // Config is written to the stack dir; restart so it takes effect — but only
    // when the unit is already running. `systemctl restart` would *start* a
    // stopped unit (oink-noalbs is off by default), and a config save must never
    // change run-state: the dashboard toggle owns start/stop.
    let restartMsg = '';
    try {
      const unit = serviceUnit(service);
      if (unit && isUnitActive(unit)) {
        systemctl('restart', unit, { timeout: 30000 });
        restartMsg = ' (service restarted)';
      } else if (unit) {
        restartMsg = ' (service stopped; applies on next start)';
      }
    } catch {
      restartMsg = ' (warning: restart failed)';
    }
    console.log(`[log-server] config write ${service} by ${user.username}@${user.role}${restartMsg}`);

    return json(res, 200, { ok: true, message: `${service} config saved${restartMsg}` });
  }

  // --- Dashboard settings (channel name + welcome state) ---

  // GET /api/settings
  if (pathname === '/api/settings' && req.method === 'GET') {
    const user = requireRole(req, res, [ROLES.ADMIN, ROLES.OPERATOR]);
    if (!user) return;
    const s = dashboardSettings.readSettings(STACK_DIR);
    return json(res, 200, {
      ok: true,
      welcomeComplete: s.welcomeComplete,
      twitchChannel: s.twitchChannel,
      presetProvided: s.presetProvided,
    });
  }

  // PUT /api/settings  {welcomeComplete?, twitchChannel?}
  if (pathname === '/api/settings' && req.method === 'PUT') {
    const user = requireRole(req, res, [ROLES.ADMIN, ROLES.OPERATOR]);
    if (!user) return;
    return handleApi(res, async () => {
      const body = await readJson(req);
      const next = dashboardSettings.readSettings(STACK_DIR);
      if (body.welcomeComplete !== undefined) {
        if (typeof body.welcomeComplete !== 'boolean') {
          throw new InputError('welcomeComplete must be a boolean');
        }
        next.welcomeComplete = body.welcomeComplete;
      }
      if (body.twitchChannel !== undefined) {
        next.twitchChannel = dashboardSettings.normalizeChannel(body.twitchChannel);
      }
      const saved = dashboardSettings.writeSettings(STACK_DIR, next);
      // NOALBS joins/listens in chat.username, so a channel change must follow
      // into its config and (if running) restart it — NOALBS reads config once
      // at start. Same "only restart an active unit" rule as config saves.
      if (body.twitchChannel !== undefined && setNoalbsChannel(saved.twitchChannel)) {
        const unit = serviceUnit('noalbs');
        if (unit && isUnitActive(unit)) {
          try {
            systemctl('restart', unit, { timeout: 30000 });
          } catch {
            /* best effort */
          }
        }
      }
      json(res, 200, {
        ok: true,
        welcomeComplete: saved.welcomeComplete,
        twitchChannel: saved.twitchChannel,
        presetProvided: saved.presetProvided,
      });
    }, { generic: 'Failed to save dashboard settings' });
  }

  // --- OBS assets ---

  // GET /api/assets — list files stored in the OBS assets directory.
  if (pathname === '/api/assets' && req.method === 'GET') {
    try {
      fs.mkdirSync(OBS_ASSET_DIR, { recursive: true });
      const files = fs.readdirSync(OBS_ASSET_DIR, { withFileTypes: true })
        // Hide in-progress uploads (tmp names end `.up-<pid>-<ts>`).
        .filter((d) => d.isFile() && !d.name.includes('.up-'))
        .map((d) => {
          const st = fs.statSync(path.join(OBS_ASSET_DIR, d.name));
          return { name: d.name, size: st.size, mtime: st.mtimeMs };
        })
        .sort((a, b) => a.name.localeCompare(b.name));
      json(res, 200, { ok: true, files });
    } catch (e) {
      sendServerError(res, 500, e, 'Failed to list assets');
    }
    return;
  }

  // POST /api/assets — raw binary body, file name in the X-Filename header.
  if (pathname === '/api/assets' && req.method === 'POST') {
    const user = requireRole(req, res, [ROLES.ADMIN, ROLES.OPERATOR]);
    if (!user) return;
    const rawName = String(req.headers['x-filename'] || '');
    let name;
    try {
      name = sanitizeAssetName(rawName);
    } catch (e) {
      sendError(res, 400, e.message);
      return;
    }
    try {
      fs.mkdirSync(OBS_ASSET_DIR, { recursive: true });
      const filePath = path.join(OBS_ASSET_DIR, name);
      const tmpPath = `${filePath}.up-${process.pid}-${Date.now()}`;
      let size;
      try {
        size = await writeAssetStream(req, tmpPath);
      } catch (e) {
        try { fs.unlinkSync(tmpPath); } catch {}
        throw e;
      }
      // Trust the bytes, not the X-Filename extension; commitAsset rejects a
      // mismatch (unlinking the temp) and otherwise renames it into place.
      const committed = commitAsset(tmpPath, filePath, name);
      if (!committed.ok) {
        return sendError(res, 400, committed.error);
      }
      json(res, 200, { ok: true, message: `Uploaded ${name}`, file: { name, size, mtime: Date.now() } });
    } catch (e) {
      if (e instanceof InputError) {
        sendError(res, 413, e.message);
      } else {
        sendServerError(res, 500, e, 'Failed to save asset');
      }
    }
    return;
  }

  // GET/DELETE /api/assets/:name — download or remove a single asset.
  const assetMatch = pathname.match(/^\/api\/assets\/(.+)$/);
  if (assetMatch && (req.method === 'GET' || req.method === 'DELETE')) {
    const rawName = assetMatch[1];
    let name;
    try {
      name = sanitizeAssetName(decodeURIComponent(rawName));
    } catch (e) {
      sendError(res, 400, e.message);
      return;
    }
    const filePath = path.join(OBS_ASSET_DIR, name);
    try {
      assertContained(filePath, OBS_ASSET_DIR);
    } catch (e) {
      sendError(res, 400, e.message);
      return;
    }

    if (req.method === 'GET') {
      if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
        sendError(res, 404, `Asset not found: ${name}`);
        return;
      }
      try {
        // Serve the type the bytes say, falling back to the extension for
        // legacy files uploaded before the sniff existed.
        let contentType = mimeForAsset(name);
        try { contentType = sniffAssetType(filePath) || contentType; } catch {}
        res.writeHead(200, {
          'Content-Type': contentType,
          'Content-Length': fs.statSync(filePath).size,
          // Attachment + nosniff: legacy SVG/HTML assets may still be on disk;
          // force a download (browser subresource loads like <img>/<video> ignore
          // the disposition, so embedding still works) and stop content sniffing.
          'Content-Disposition': `attachment; filename="${name.replace(/"/g, '')}"`,
          'X-Content-Type-Options': 'nosniff',
        });
        fs.createReadStream(filePath).pipe(res);
      } catch (e) {
        sendServerError(res, 500, e, 'Failed to read asset');
      }
      return;
    }

    if (req.method === 'DELETE') {
      const user = requireRole(req, res, [ROLES.ADMIN, ROLES.OPERATOR]);
      if (!user) return;
      if (!fs.existsSync(filePath)) {
        sendError(res, 404, `Asset not found: ${name}`);
        return;
      }
      try {
        fs.unlinkSync(filePath);
        auditReq(user, `asset delete ${name}`);
        json(res, 200, { ok: true, message: `Deleted ${name}` });
      } catch (e) {
        sendServerError(res, 500, e, 'Failed to delete asset');
      }
      return;
    }
  }

  // --- OBS recordings ---

  // GET /api/recordings — list recorded clips (newest first) with a hint about
  // whether a cached thumbnail already exists.
  if (pathname === '/api/recordings' && req.method === 'GET') {
    try {
      fs.mkdirSync(OBS_RECORDING_DIR, { recursive: true });
      const files = fs.readdirSync(OBS_RECORDING_DIR, { withFileTypes: true })
        .filter((d) => d.isFile() && isRecordingName(d.name))
        .map((d) => {
          const st = fs.statSync(path.join(OBS_RECORDING_DIR, d.name));
          return {
            name: d.name,
            size: st.size,
            mtime: st.mtimeMs,
            hasThumb: fs.existsSync(recordingThumbPath(d.name)),
          };
        })
        .sort((a, b) => b.mtime - a.mtime);
      json(res, 200, { ok: true, files });
    } catch (e) {
      sendServerError(res, 500, e, 'Failed to list recordings');
    }
    return;
  }

  // GET /api/recordings/:name/thumb.jpg — preview frame, generated on demand.
  const thumbMatch = pathname.match(/^\/api\/recordings\/(.+?)\/thumb\.jpg$/i);
  if (thumbMatch && req.method === 'GET') {
    let name;
    try {
      name = sanitizeAssetName(decodeURIComponent(thumbMatch[1]));
    } catch (e) {
      sendError(res, 400, e.message);
      return;
    }
    if (!isRecordingName(name)) {
      sendError(res, 400, 'Not a video recording');
      return;
    }
    const filePath = path.join(OBS_RECORDING_DIR, name);
    if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
      sendError(res, 404, `Recording not found: ${name}`);
      return;
    }
    try {
      assertContained(filePath, OBS_RECORDING_DIR);
    } catch (e) {
      sendError(res, 400, e.message);
      return;
    }
    try {
      const thumbPath = await ensureRecordingThumb(name);
      const size = fs.statSync(thumbPath).size;
      res.writeHead(200, {
        'Content-Type': 'image/jpeg',
        'Content-Length': size,
        'Cache-Control': 'public, max-age=3600',
      });
      fs.createReadStream(thumbPath).pipe(res);
    } catch (e) {
      if (e instanceof BusyError) {
        sendError(res, 503, e.message);
      } else {
        sendError(res, 404, `No thumbnail available for ${name}`);
      }
    }
    return;
  }

  // GET/DELETE /api/recordings/:name — stream (Range-aware, `download=1` to
  // attach) or remove a single clip plus its cached thumbnail.
  const recMatch = pathname.match(/^\/api\/recordings\/(.+)$/);
  if (recMatch && (req.method === 'GET' || req.method === 'DELETE')) {
    let name;
    try {
      name = sanitizeAssetName(decodeURIComponent(recMatch[1]));
    } catch (e) {
      sendError(res, 400, e.message);
      return;
    }
    if (!isRecordingName(name)) {
      sendError(res, 400, 'Not a video recording');
      return;
    }
    const filePath = path.join(OBS_RECORDING_DIR, name);
    try {
      assertContained(filePath, OBS_RECORDING_DIR);
    } catch (e) {
      sendError(res, 400, e.message);
      return;
    }

    if (req.method === 'DELETE') {
      const user = requireRole(req, res, [ROLES.ADMIN, ROLES.OPERATOR]);
      if (!user) return;
      if (!fs.existsSync(filePath)) {
        sendError(res, 404, `Recording not found: ${name}`);
        return;
      }
      try {
        fs.unlinkSync(filePath);
        try { fs.unlinkSync(recordingThumbPath(name)); } catch {}
        auditReq(user, `recording delete ${name}`);
        json(res, 200, { ok: true, message: `Deleted ${name}` });
      } catch (e) {
        sendServerError(res, 500, e, 'Failed to delete recording');
      }
      return;
    }

    if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
      sendError(res, 404, `Recording not found: ${name}`);
      return;
    }
    try {
      serveFileWithRange(req, res, filePath, name, parsed.query.download === '1');
    } catch (e) {
      sendServerError(res, 500, e, 'Failed to read recording');
    }
    return;
  }

  // --- OBS bridge ---

  // GET /api/obs/scenes
  if (pathname === '/api/obs/scenes' && req.method === 'GET') {
    return handleApi(res, async () => {
      json(res, 200, { ok: true, ...(await listScenes()) });
    }, { server: 502, generic: 'OBS is unreachable or not provisioned' });
  }

  // POST /api/obs/scenes/switch  {sceneName}
  if (pathname === '/api/obs/scenes/switch' && req.method === 'POST') {
    const user = requireRole(req, res, [ROLES.ADMIN, ROLES.OPERATOR]);
    void user;
    return handleApi(res, async () => {
      const { sceneName } = await readJson(req);
      if (!sceneName || typeof sceneName !== 'string' || !sceneName.trim()) {
        throw new InputError('sceneName is required');
      }
      const result = await switchScene(sceneName.trim());
      json(res, 200, { ok: true, message: `Switched to scene "${result.sceneName}"`, ...result });
    }, { server: 502, generic: 'Failed to switch OBS scene' });
  }

  // POST /api/obs/stream/start
  if (pathname === '/api/obs/stream/start' && req.method === 'POST') {
    const user = requireRole(req, res, [ROLES.ADMIN, ROLES.OPERATOR]);
    void user;
    return handleApi(res, async () => {
      const result = await startStream();
      json(res, 200, { ok: true, message: 'Stream started', ...result });
    }, { server: 502, generic: 'Failed to start stream' });
  }

  // POST /api/obs/stream/stop
  if (pathname === '/api/obs/stream/stop' && req.method === 'POST') {
    const user = requireRole(req, res, [ROLES.ADMIN, ROLES.OPERATOR]);
    void user;
    return handleApi(res, async () => {
      const result = await stopStream();
      json(res, 200, { ok: true, message: 'Stream stopped', ...result });
    }, { server: 502, generic: 'Failed to stop stream' });
  }

  // GET /api/obs/stream/status
  if (pathname === '/api/obs/stream/status' && req.method === 'GET') {
    return handleApi(res, async () => {
      const status = await getStreamStatus();
      json(res, 200, { ok: true, ...status });
    }, { server: 502, generic: 'Failed to get stream status' });
  }

  // POST /api/obs/record/start
  if (pathname === '/api/obs/record/start' && req.method === 'POST') {
    const user = requireRole(req, res, [ROLES.ADMIN, ROLES.OPERATOR]);
    void user;
    return handleApi(res, async () => {
      const result = await startRecording();
      json(res, 200, { ok: true, message: 'Recording started', ...result });
    }, { server: 502, generic: 'Failed to start recording' });
  }

  // POST /api/obs/record/stop
  if (pathname === '/api/obs/record/stop' && req.method === 'POST') {
    const user = requireRole(req, res, [ROLES.ADMIN, ROLES.OPERATOR]);
    void user;
    return handleApi(res, async () => {
      const result = await stopRecording();
      json(res, 200, { ok: true, message: 'Recording stopped', ...result });
    }, { server: 502, generic: 'Failed to stop recording' });
  }

  // GET /api/obs/record/status
  if (pathname === '/api/obs/record/status' && req.method === 'GET') {
    return handleApi(res, async () => {
      const status = await getRecordingStatus();
      json(res, 200, { ok: true, ...status });
    }, { server: 502, generic: 'Failed to get recording status' });
  }

  // GET /api/preview/stream — OBS virtual camera → multipart MJPEG for the
  // dashboard preview <img>. Same session-cookie auth as every other route; the
  // response is a live stream, so it bypasses the JSON envelope.
  if (pathname === '/api/preview/stream' && req.method === 'GET') {
    const user = requireRole(req, res, [ROLES.ADMIN, ROLES.OPERATOR, ROLES.VIEWER]);
    if (!user) return;
    return streamPreview(res);
  }

  // GET /api/obs/stream-settings
  if (pathname === '/api/obs/stream-settings' && req.method === 'GET') {
    return handleApi(res, async () => {
      json(res, 200, { ok: true, ...(await getStreamSettings()) });
    }, { server: 502, generic: 'OBS is unreachable or not provisioned' });
  }

  // PUT /api/obs/stream-settings  {encoder, outputWidth, outputHeight, fpsNumerator, fpsDenominator, bitrate}
  if (pathname === '/api/obs/stream-settings' && req.method === 'PUT') {
    const user = requireRole(req, res, [ROLES.ADMIN, ROLES.OPERATOR]);
    void user;
    return handleApi(res, async () => {
      const settings = await readJson(req);
      validateStreamSettings(settings);
      const result = await setStreamSettings(settings);
      json(res, 200, { ok: true, message: 'Stream settings updated', ...result });
    }, { server: 502, generic: 'Failed to update OBS stream settings' });
  }

  // POST /api/obs/media-source  {name, url}
  // Provision an ingest read source in OBS. Always the obs-irl-source plugin's
  // `irl_source` input (it does the PTS repair / A-V sync Media Source cannot);
  // requires the plugin to be installed/loaded in OBS.
  if (pathname === '/api/obs/media-source' && req.method === 'POST') {
    const user = requireRole(req, res, [ROLES.ADMIN, ROLES.OPERATOR]);
    void user;
    return handleApi(res, async () => {
      const { name, url: mediaUrl } = await readJson(req);
      if (!name || typeof name !== 'string' || !name.trim()) throw new InputError('name is required');
      const trimmedUrl = (mediaUrl || '').trim();
      if (!/^(rtsp|srt):\/\//i.test(trimmedUrl)) {
        throw new InputError('url must be an rtsp:// or srt:// URL');
      }
      const result = await provisionMediaSource(name.trim(), trimmedUrl);
      json(res, 200, { ok: true, message: `IRL Source "${name}" provisioned in scene "main"`, ...result });
    }, { server: 502, generic: 'Failed to provision media source in OBS' });
  }

  // DELETE /api/obs/media-source?name=...
  // Remove a media source from OBS (both scene item and input)
  if (pathname === '/api/obs/media-source' && req.method === 'DELETE') {
    const user = requireRole(req, res, [ROLES.ADMIN, ROLES.OPERATOR]);
    void user;
    return handleApi(res, async () => {
      const name = new URLSearchParams(parsed.search).get('name');
      if (!name || typeof name !== 'string' || !name.trim()) {
        throw new InputError('name query parameter is required');
      }
      await deleteMediaSource(name.trim());
      json(res, 200, { ok: true, message: `Media source "${name}" removed from OBS` });
    }, { server: 502, generic: 'Failed to remove media source from OBS' });
  }

  // GET /api/obs/media-source/state?names=a,b — per-feed mute + scene-item
  // visibility for the dashboard's ingest controls. Feeds with no OBS input are
  // omitted, so the UI disables their controls.
  if (pathname === '/api/obs/media-source/state' && req.method === 'GET') {
    const user = requireRole(req, res, [ROLES.ADMIN, ROLES.OPERATOR, ROLES.VIEWER]);
    if (!user) return;
    return handleApi(res, async () => {
      const names = (new URLSearchParams(parsed.search).get('names') || '')
        .split(',').map((s) => s.trim()).filter(Boolean).slice(0, 50);
      json(res, 200, { ok: true, sources: await getIngestControls(names) });
    }, { server: 502, generic: 'Failed to read ingest source state from OBS' });
  }

  // POST /api/obs/media-source/mute  {name, muted}
  if (pathname === '/api/obs/media-source/mute' && req.method === 'POST') {
    const user = requireRole(req, res, [ROLES.ADMIN, ROLES.OPERATOR]);
    if (!user) return;
    return handleApi(res, async () => {
      const { name, muted } = await readJson(req);
      if (!name || typeof name !== 'string' || !name.trim()) throw new InputError('name is required');
      if (typeof muted !== 'boolean') throw new InputError('muted must be a boolean');
      json(res, 200, { ok: true, ...(await setIngestMute(name.trim(), muted)) });
    }, { server: 502, generic: 'Failed to set ingest mute in OBS' });
  }

  // POST /api/obs/media-source/visibility  {name, visible}
  if (pathname === '/api/obs/media-source/visibility' && req.method === 'POST') {
    const user = requireRole(req, res, [ROLES.ADMIN, ROLES.OPERATOR]);
    if (!user) return;
    return handleApi(res, async () => {
      const { name, visible } = await readJson(req);
      if (!name || typeof name !== 'string' || !name.trim()) throw new InputError('name is required');
      if (typeof visible !== 'boolean') throw new InputError('visible must be a boolean');
      json(res, 200, { ok: true, ...(await setIngestVisible(name.trim(), visible)) });
    }, { server: 502, generic: 'Failed to set ingest visibility in OBS' });
  }

  // POST /api/obs/media-source/restart  {name}: restart
  // the feed's media input (clears decoder stalls / A/V build-up; the MediaMTX
  // path and mute state are untouched).
  if (pathname === '/api/obs/media-source/restart' && req.method === 'POST') {
    const user = requireRole(req, res, [ROLES.ADMIN, ROLES.OPERATOR]);
    if (!user) return;
    return handleApi(res, async () => {
      const { name } = await readJson(req);
      if (!name || typeof name !== 'string' || !name.trim()) throw new InputError('name is required');
      json(res, 200, { ok: true, ...(await restartIngestSource(name.trim())) });
    }, { server: 502, generic: 'Failed to restart ingest source in OBS' });
  }

  // --- OBS plugin manager (default plugins + uploads) ---

  // GET /api/obs/plugins/status — status of the default (build) plugins:
  // installed = .so on disk; loaded = probe-based (input kind for
  // obs-irl-source, .so-mtime-vs-unit-start for the Aitum plugins).
  if (pathname === '/api/obs/plugins/status' && req.method === 'GET') {
    const user = requireRole(req, res, [ROLES.ADMIN, ROLES.OPERATOR, ROLES.VIEWER]);
    if (!user) return;
    return handleApi(res, async () => {
      const plugins = [];
      for (const meta of DEFAULT_PLUGINS) {
        const installed = pluginInstalled(meta.name);
        plugins.push({
          name: meta.name,
          version: meta.version,
          installed,
          loaded: installed ? await pluginLoaded(meta) : false,
          dir: path.join(OBS_PLUGIN_DIR, meta.name),
          kind: meta.kind,
          default: true,
        });
      }
      json(res, 200, { ok: true, plugins });
    }, { server: 500, generic: 'Failed to read plugin status' });
  }

  // GET /api/versions — one-shot version report for the dashboard's Versions
  // tab (copy-paste into GitHub issues). See collectVersions() for the sources;
  // every probe degrades to null rather than failing the response.
  if (pathname === '/api/versions' && req.method === 'GET') {
    const user = requireRole(req, res, [ROLES.ADMIN, ROLES.OPERATOR, ROLES.VIEWER]);
    if (!user) return;
    return handleApi(res, async () => {
      json(res, 200, { ok: true, ...(await collectVersions()) });
    }, { server: 500, generic: 'Failed to read versions' });
  }

  // GET /api/log-bundle — stream a .zip of the MediaMTX + NOALBS journald logs,
  // every OBS log file, and versions.txt, for attaching to a GitHub issue.
  // Deliberately NOT under /api/logs/ (that nginx location forces the WebSocket
  // upgrade headers). Logs can leak secrets, so operator/admin only.
  if (pathname === '/api/log-bundle' && req.method === 'GET') {
    const user = requireRole(req, res, [ROLES.ADMIN, ROLES.OPERATOR]);
    if (!user) return;
    return handleApi(res, async () => {
      const versions = await collectVersions();
      const made = logs.createLogsArchive({
        extraFiles: { 'versions.txt': versionsToText(versions) },
      });
      auditReq(user, `logs download (${made.count} files)`);
      const filename = path.basename(made.file);
      res.writeHead(200, {
        'Content-Type': 'application/zip',
        'Content-Length': fs.statSync(made.file).size,
        'Content-Disposition': `attachment; filename="${filename.replace(/"/g, '')}"`,
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
      });
      const cleanup = () => fs.rmSync(made.dir, { recursive: true, force: true });
      const stream = fs.createReadStream(made.file);
      stream.on('error', (e) => {
        cleanup();
        if (!res.headersSent) sendServerError(res, 500, e, 'Failed to stream the log bundle');
        else res.destroy();
      });
      stream.on('close', cleanup);
      res.on('close', cleanup);
      stream.pipe(res);
    }, { server: 500, generic: 'Failed to create the log bundle' });
  }

  // POST /api/obs/plugins/<name>/install — download the pinned release for one
  // of the default plugins, verify its checksum, and install it (.deb or tarball).
  // Does NOT restart OBS: the UI asks the operator to confirm before calling
  // POST /api/obs/restart so a live stream is not dropped silently.
  // DELETE /api/obs/plugins/<name> — default plugins are part of the build and
  // cannot be removed (403); nothing else is managed for deletion.
  const pluginMatch = /^\/api\/obs\/plugins\/([^/]+)(\/install)?$/.exec(pathname);
  if (pluginMatch) {
    const name = decodeURIComponent(pluginMatch[1]);
    const meta = defaultPlugin(name);

    if (pluginMatch[2] && req.method === 'POST') {
      // Native plugin code runs inside OBS as the stack owner, so installing one
      // is admin-only (operator could otherwise read api.env / forge sessions).
      const user = requireRole(req, res, [ROLES.ADMIN]);
      if (!user) return;
      if (!meta) {
        sendError(res, 404, `Unknown plugin '${name}'`);
        return;
      }
      const stage = fs.mkdtempSync(path.join(OBS_PLUGIN_DIR, '.stage-'));
      const ext = meta.kind === 'deb' ? 'deb' : 'tar.gz';
      const asset = path.join(stage, `${meta.name}.${ext}`);
      return handleApi(res, async () => {
        await _downloadFile(meta.url, asset);
        const digest = _sha256File(asset);
        if (digest !== meta.sha256) {
          throw new InputError(`Checksum mismatch for ${meta.name} ${meta.version}`);
        }
        const res0 = meta.kind === 'deb'
          ? _installPluginDeb(asset, meta.name)
          : _installPluginArchive(asset, meta.name, { allowDefault: true });
        auditReq(user, `installed ${meta.name} ${meta.version} plugin`);
        json(res, 200, {
          ok: true,
          message: `${meta.name} ${meta.version} installed — restart OBS to load it`,
          ...res0,
          restartRequired: true,
        });
      }, { server: 502, generic: `Failed to install ${meta.name}` }).finally(() => {
        fs.rmSync(stage, { recursive: true, force: true });
      });
    }

    if (req.method === 'DELETE') {
      const user = requireRole(req, res, [ROLES.ADMIN]);
      if (!user) return;
      if (meta) {
        const dest = path.join(OBS_PLUGIN_DIR, meta.name);
        sendError(
          res, 403,
          `${meta.name} is a default plugin of the build and cannot be removed` +
          (fs.existsSync(dest) ? ''
            : ` (not currently installed — it is installed by 'oink.py setup')`),
        );
      } else {
        sendError(res, 404, `Unknown plugin '${name}'`);
      }
      return;
    }
  }

  // GET /api/obs/multistream/keys — whether Aitum Multistream has a stream key
  // configured for each non-primary platform. Raw keys are never returned;
  // only a set/not-set flag and the last four characters.
  if (pathname === '/api/obs/multistream/keys' && req.method === 'GET') {
    const user = requireRole(req, res, [ROLES.ADMIN, ROLES.OPERATOR]);
    if (!user) return;
    return handleApi(res, async () => {
      const config = readMultistreamConfig();
      const bridge = await ensureObs();
      const reqFn = (type, data) => bridge.request(type, data);
      const primaryPlatform = await _getPrimaryPlatform(reqFn);
      const allState = multistreamKeyState(config);
      // Filter out the primary platform from the multistream response
      const platforms = {};
      for (const [platform, status] of Object.entries(allState)) {
        if (platform !== primaryPlatform) {
          platforms[platform] = status;
        }
      }
      json(res, 200, { ok: true, platforms, primaryPlatform });
    }, { server: 500, generic: 'Failed to read Aitum Multistream config' });
  }

  // PUT /api/obs/multistream/keys  {twitch?, kick?, youtube?}
  // Write the given platform stream keys into Aitum Multistream's config for
  // every profile. The primary platform is excluded (it uses OBS native output).
  // OBS reads this file only on start / profile change, so the UI must offer
  // a restart (POST /api/obs/restart) before keys take effect.
  if (pathname === '/api/obs/multistream/keys' && req.method === 'PUT') {
    const user = requireRole(req, res, [ROLES.ADMIN, ROLES.OPERATOR]);
    if (!user) return;
    let obsWasStopped = false;
    return handleApi(res, async () => {
      const body = await readJson(req);
      if (!body || typeof body !== 'object') {
        throw new InputError('Request body must be a JSON object');
      }
      
      // Get primary platform to exclude it from multistream
      const bridge = await ensureObs();
      const reqFn = (type, data) => bridge.request(type, data);
      const primaryPlatform = await _getPrimaryPlatform(reqFn);

      const keys = {};
      for (const platform of Object.keys(MULTISTREAM_PLATFORMS)) {
        if (platform === primaryPlatform) continue; // Skip primary platform
        const raw = body[platform];
        if (raw === undefined || raw === null) continue;
        if (typeof raw !== 'string') {
          throw new InputError(`${platform} stream key must be a string`);
        }
        const key = raw.trim();
        if (!key) continue; // empty field = leave unchanged
        if (key.length > 512 || /[\s\\"\u0000-\u001f\u007f]/.test(key)) {
          throw new InputError(`${platform} stream key looks invalid (no spaces or special characters)`);
        }
        keys[platform] = key;
      }
      
      if (Object.keys(keys).length === 0) {
        throw new InputError('Provide at least one stream key for a non-primary platform');
      }
      
      // Stop OBS before writing config to prevent Aitum Multistream plugin from overwriting our changes
      console.log('[multistream PUT] Stopping OBS to safely write config...');
      stopObsUnit();
      obsWasStopped = true;

      // Wait for OBS to shut down via systemctl (reliable; the old `pgrep -f
      // 'obs --websocket'` substring probe could false-match another process).
      const stopped = await waitOBSStopped(10000);
      if (!stopped) {
        console.log('[multistream PUT] Warning: OBS did not stop within 10 seconds, proceeding anyway...');
      } else {
        console.log('[multistream PUT] OBS stopped');
      }

      const config = readMultistreamConfig();
      
      applyMultistreamKeys(config, keys);
      
      writeMultistreamConfig(config);
      auditReq(user, `updated Aitum Multistream keys (${Object.keys(keys).join(', ')})`);
      
      // Start OBS after writing config
      console.log('[multistream PUT] Starting OBS...');
      startObsUnit();
      obsWasStopped = false;
      
      const allState = multistreamKeyState(config);
      const platforms = {};
      for (const [platform, status] of Object.entries(allState)) {
        if (platform !== primaryPlatform) {
          platforms[platform] = status;
        }
      }
      json(res, 200, {
        ok: true,
        message: 'Multistream keys saved — OBS restarted automatically',
        restartRequired: false,
        platforms,
        primaryPlatform,
      });
    }, { server: 500, generic: 'Failed to update Aitum Multistream keys' }).finally(() => {
      // Always restart OBS if we stopped it, even if an error occurred
      if (obsWasStopped) {
        console.log('[multistream PUT] Restarting OBS after error...');
        try {
          startObsUnit();
        } catch (restartErr) {
          console.error('[multistream PUT] Failed to restart OBS:', restartErr);
        }
      }
    });
  }

  // POST /api/obs/plugins  (body = raw plugin tarball, X-Filename: *.tar.*)
  // Upload an arbitrary OBS drop-in plugin archive (gzip/xz/bzip2 tar). Generic
  // path for third-party plugins; archives whose top-level name collides with a
  // default (build) plugin are refused — those come from the pinned installer.
  if (pathname === '/api/obs/plugins' && req.method === 'POST') {
    // Arbitrary native code as the stack owner — admin-only (see install above).
    const user = requireRole(req, res, [ROLES.ADMIN]);
    if (!user) return;
    const rawName = String(req.headers['x-filename'] || '').trim();
    const baseName = path.basename(rawName || 'plugin.tar.gz');
    if (!/\.(tar\.gz|tgz|tar\.xz|tar\.bz2|tar)$/i.test(baseName)) {
      sendError(res, 400, 'X-Filename must end in .tar.gz/.tgz/.tar.xz/.tar.bz2/.tar');
      return;
    }
    const stage = fs.mkdtempSync(path.join(OBS_PLUGIN_DIR, '.stage-'));
    const tarFile = path.join(stage, baseName);
    return handleApi(res, async () => {
      const size = await writeAssetStream(req, tarFile, PLUGIN_UPLOAD_MAX_BYTES);
      if (size === 0) throw new InputError('Empty upload');
      const res0 = _installPluginArchive(tarFile, null);
      auditReq(user, `uploaded plugin archive '${baseName}' -> ${res0.name}`);
      json(res, 200, {
        ok: true,
        message: `Plugin "${res0.name}" installed — restart OBS to load it`,
        ...res0,
        restartRequired: true,
      });
    }, { server: 502, generic: 'Failed to install uploaded plugin' }).finally(() => {
      fs.rmSync(stage, { recursive: true, force: true });
    });
  }

  // GET /api/obs/stream-service — current OBS native stream service settings
  // Returns service name, server URL, and masked key (last 4 chars only).
  if (pathname === '/api/obs/stream-service' && req.method === 'GET') {
    const user = requireRole(req, res, [ROLES.ADMIN, ROLES.OPERATOR]);
    if (!user) return;
    return handleApi(res, async () => {
      const result = await getStreamService();
      json(res, 200, { ok: true, ...result });
    }, { server: 502, generic: 'Failed to get OBS stream service' });
  }

  // PUT /api/obs/stream-service  {key}
  // Sets the stream key for OBS's native output (main canvas). The service
  // and server are determined by the current primary platform setting.
  if (pathname === '/api/obs/stream-service' && req.method === 'PUT') {
    const user = requireRole(req, res, [ROLES.ADMIN, ROLES.OPERATOR]);
    if (!user) return;
    return handleApi(res, async () => {
      const { key } = await readJson(req);
      if (typeof key !== 'string' || !key.trim()) {
        throw new InputError('key must be a non-empty string');
      }
      const trimmedKey = key.trim();
      if (trimmedKey.length > 512 || /[\s\\"\u0000-\u001f\u007f]/.test(trimmedKey)) {
        throw new InputError('stream key looks invalid (no spaces or special characters)');
      }
      
      const result = await setStreamServiceKey(trimmedKey);
      auditReq(user, `updated OBS stream service key for primary platform`);
      
      json(res, 200, { ok: true, message: 'Stream service key saved — restart OBS to apply', restartRequired: true, ...result });
    }, { server: 502, generic: 'Failed to update OBS stream service' });
  }

  // GET /api/obs/primary-platform — which platform uses OBS's native output
  // Returns the current primary platform id (twitch, youtube, or kick).
  if (pathname === '/api/obs/primary-platform' && req.method === 'GET') {
    const user = requireRole(req, res, [ROLES.ADMIN, ROLES.OPERATOR]);
    if (!user) return;
    return handleApi(res, async () => {
      const platform = await getPrimaryPlatform();
      json(res, 200, { ok: true, platform });
    }, { server: 502, generic: 'Failed to get primary platform' });
  }

  // PUT /api/obs/primary-platform  {platform, server}
  // Switches which platform uses OBS's native output. Also configures the
  // OBS stream service to match the new primary platform's RTMP server.
  // `server` is required for platform "custom-rtmp" (any RTMP ingest endpoint).
  if (pathname === '/api/obs/primary-platform' && req.method === 'PUT') {
    const user = requireRole(req, res, [ROLES.ADMIN, ROLES.OPERATOR]);
    if (!user) return;
    return handleApi(res, async () => {
      const { platform, server } = await readJson(req);
      if (!PLATFORMS[platform] && platform !== 'custom-rtmp') {
        throw new InputError('platform must be "twitch", "youtube", "kick", or "custom-rtmp"');
      }
      
      const result = await setPrimaryPlatform(platform, server);
      auditReq(user, `set primary platform to ${platform}`);
      
      json(res, 200, { ok: true, message: 'Primary platform updated — restart OBS to apply', restartRequired: true, ...result });
    }, { server: 502, generic: 'Failed to update primary platform' });
  }

  // POST /api/obs/restart — restart oink-obs. Only reached after the operator
  // confirms in the UI (a restart drops the live ingest for a few seconds).
  if (pathname === '/api/obs/restart' && req.method === 'POST') {
    const user = requireRole(req, res, [ROLES.ADMIN, ROLES.OPERATOR]);
    if (!user) return;
    return handleApi(res, () => {
      restartObsUnit();
      auditReq(user, `restarted oink-obs (plugin apply)`);
      json(res, 200, { ok: true, message: 'OBS restarted' });
    }, { server: 500, generic: 'Failed to restart OBS' });
  }

  // POST /api/obs/browser-source  {name, url, scenes}
  // Upsert an overlay browser source (e.g. a widget URL) as a full-canvas scene
  // item into each of the requested scenes (brb, low-br, offline, ...).
  if (pathname === '/api/obs/browser-source' && req.method === 'POST') {
    const user = requireRole(req, res, [ROLES.ADMIN, ROLES.OPERATOR]);
    void user;
    return handleApi(res, async () => {
      const { name, url: widgetUrl, scenes, reroute_audio } = await readJson(req);
      if (!name || typeof name !== 'string' || !name.trim()) throw new InputError('name is required');
      const trimmedUrl = (widgetUrl || '').trim();
      if (!/^https?:\/\//i.test(trimmedUrl)) {
        throw new InputError('url must be an http(s):// URL');
      }
      if (!Array.isArray(scenes) || scenes.length === 0 ||
          scenes.some((s) => typeof s !== 'string' || !s.trim())) {
        throw new InputError('scenes must be a non-empty array of scene names');
      }
      const targets = [...new Set(scenes.map((s) => s.trim()))];
      const result = await provisionBrowserSource(
        name.trim(),
        trimmedUrl,
        targets,
        { rerouteAudio: reroute_audio === true },
      );
      json(res, 200, {
        ok: true,
        message: `Browser source "${name}" provisioned in ${targets.join(', ')}`,
        ...result,
      });
    }, { server: 502, generic: 'Failed to provision browser source in OBS' });
  }

  // DELETE /api/obs/browser-source?name=...
  if (pathname === '/api/obs/browser-source' && req.method === 'DELETE') {
    const user = requireRole(req, res, [ROLES.ADMIN, ROLES.OPERATOR]);
    void user;
    return handleApi(res, async () => {
      const name = new URLSearchParams(parsed.search).get('name');
      if (!name || typeof name !== 'string' || !name.trim()) {
        throw new InputError('name query parameter is required');
      }
      await deleteBrowserSource(name.trim());
      json(res, 200, { ok: true, message: `Browser source "${name}" removed from OBS` });
    }, { server: 502, generic: 'Failed to remove browser source from OBS' });
  }

// --- Ingest stream key ---

  // GET /api/ingest — the node's stream key + canonical default ingest path.
  // The key is the bearer credential for publishing/reading to MediaMTX; only
  // operator/admin may view it (viewers are not offered the Ingest page).
  if (pathname === '/api/ingest' && req.method === 'GET') {
    const user = requireRole(req, res, [ROLES.ADMIN, ROLES.OPERATOR]);
    if (!user) return;
    return handleApi(res, () => {
      const state = ingest.ensureState(STACK_DIR);
      json(res, 200, {
        ok: true,
        key: state.key,
        defaultPath: ingest.canonicalPath(state.key, ingest.RESERVED_LABEL),
        createdAt: state.createdAt,
        updatedAt: state.updatedAt,
      });
    }, { server: 500, generic: 'Failed to read ingest stream key' });
  }

  // GET /api/ingest/profiles — the operator's saved ingest feeds (labels) and
  // which one is currently monitored by NOALBS. Any signed-in role may read them.
  if (pathname === '/api/ingest/profiles' && req.method === 'GET') {
    const user = requireRole(req, res, [ROLES.ADMIN, ROLES.OPERATOR, ROLES.VIEWER]);
    if (!user) return;
    return handleApi(res, () => {
      const state = ingest.readProfileState(STACK_DIR);
      json(res, 200, { ok: true, profiles: state.profiles, main: state.main });
    }, { server: 500, generic: 'Failed to read ingest profiles' });
  }

  // PUT /api/ingest/profiles {profiles:[...], main: <label>} — replace the saved
  // list. The reserved `irl` profile is always kept; `main` is which single feed
  // NOALBS monitors. When the monitored feed changes, re-point NOALBS and
  // restart it (only while it is running).
  if (pathname === '/api/ingest/profiles' && req.method === 'PUT') {
    const user = requireRole(req, res, [ROLES.ADMIN, ROLES.OPERATOR]);
    if (!user) return;
    try {
      const body = await readJson(req);
      const prev = ingest.readProfileState(STACK_DIR);
      const state = ingest.writeProfileState(STACK_DIR, body);
      if (state.main !== prev.main && ingest.setNoalbsMain(STACK_DIR, state.main)) {
        if (isUnitActive('oink-noalbs')) {
          systemctl('restart', 'oink-noalbs', { timeout: 30000 });
        }
      }
      auditReq(user, `ingest profiles update (${state.profiles.length}, main=${state.main})`);
      return json(res, 200, { ok: true, profiles: state.profiles, main: state.main });
    } catch (e) {
      return sendError(res, 400, e.message);
    }
  }

  // POST /api/ingest/rotate — generate a new stream key, rewrite the keyed
  // mediamtx.yml + NOALBS statsUrl, and restart oink-mediamtx so the new
  // namespace takes effect. Disruptive: any active phone encoder and the OBS
  // SRT reader must reconnect with the new key (re-provision OBS from the UI).
  if (pathname === '/api/ingest/rotate' && req.method === 'POST') {
    const user = requireRole(req, res, [ROLES.ADMIN, ROLES.OPERATOR]);
    if (!user) return;
    let newKey;
    try {
      newKey = ingest.generateKey();
      const res2 = ingest.applyStreamKey(STACK_DIR, newKey);
      // Restart MediaMTX so the new keyed namespace is live. A failure here is
      // reported but not fatal — the key/state/config are already updated.
      let restarted = false;
      try {
        systemctl('restart', 'oink-mediamtx', { timeout: 30000 });
        restarted = true;
      } catch (e) {
        console.error('[log-server] ingest rotate: mediamtx restart failed:', e);
      }
      auditReq(user, `rotate ingest stream key (${res2.changed.join(', ') || 'no files changed'}, restarted=${restarted})`);
      json(res, 200, {
        ok: true,
        key: newKey,
        defaultPath: ingest.canonicalPath(newKey, ingest.RESERVED_LABEL),
        restarted,
        changed: res2.changed,
      });
    } catch (e) {
      sendServerError(res, 500, e, 'Failed to rotate ingest stream key');
    }
    return;
  }

  sendError(res, 404, 'Not found');
});

// --- WebSocket log streaming ---

const wss = new WebSocketServer({ server });

function serviceUnit(name) {
  // noalbs_env edits the .env that oink-noalbs loads at start, so a save
  // restarts the same unit. Kept out of CTRL_UNITS so it stays off the
  // start/stop allowlist (polkit rule matches unit names, not config keys).
  if (name === 'noalbs_env') return CTRL_UNITS.noalbs;
  return CTRL_UNITS[name] || null;
}

function getLatestObsLog() {
  try {
    if (!fs.existsSync(OBS_LOG_DIR)) return null;
    const files = fs.readdirSync(OBS_LOG_DIR)
      .filter(f => f.endsWith('.log') || f.endsWith('.txt'))
      .map(f => ({
        name: f,
        time: fs.statSync(path.join(OBS_LOG_DIR, f)).mtime.getTime(),
      }))
      .sort((a, b) => b.time - a.time);
    return files.length > 0 ? path.join(OBS_LOG_DIR, files[0].name) : null;
  } catch {
    return null;
  }
}

// --- Controller status events (/api/ws) ---
// Every authenticated dashboard gets the same JSON snapshot on a 2.5s cadence.
// The snapshot is only built while at least one status client is connected, so
// an idle box does no MediaMTX/OBS polling on its behalf.
const statusClients = new Set();
// Per-feed byte-counter state, keyed by ingest label, for the bitrate deltas.
let _statusPrevRates = new Map();

async function fetchMediamtxPaths() {
  try {
    const res = await fetch('http://127.0.0.1:9997/v3/paths/list', {
      signal: AbortSignal.timeout(1000),
    });
    if (!res.ok) return null;
    const data = await res.json();
    return Array.isArray(data.items) ? data.items : [];
  } catch {
    return null;
  }
}

// host-info.json is written by `oink setup` (stack phase) and holds the pinned
// mediamtx/noalbs versions alongside the NVENC flag.
function readHostInfo() {
  try {
    return JSON.parse(fs.readFileSync(path.join(STACK_DIR, 'host-info.json'), 'utf-8'));
  } catch {
    return {};
  }
}

// MediaMTX Control API on loopback exposes its version at /v3/info.
async function fetchMediamtxVersion() {
  try {
    const res = await fetch('http://127.0.0.1:9997/v3/info', {
      signal: AbortSignal.timeout(1000),
    });
    if (!res.ok) return null;
    const data = await res.json();
    return data && data.version ? String(data.version) : null;
  } catch {
    return null;
  }
}

// Last OBS version OBS itself recorded in global.ini — a fallback for when the
// obs-websocket bridge is down.
function readObsLastVersion() {
  try {
    const text = fs.readFileSync(path.join(path.dirname(OBS_LOG_DIR), 'global.ini'), 'utf-8');
    const m = /^\s*LastVersion\s*=\s*(.+)$/im.exec(text);
    return m ? m[1].trim() : null;
  } catch {
    return null;
  }
}

// Compose the version report used by /api/versions and versions.txt in the log
// bundle: OINK (this build), OBS + obs-websocket (live via the websocket
// bridge), MediaMTX (live /v3/info, falling back to the pinned host-info.json
// value), NOALBS (pinned in host-info.json — no runtime probe exists), the
// default plugins, and the Node/OS runtime. Every probe degrades to null.
async function collectVersions() {
  const binVersions = readHostInfo().versions || {};
  const [obs, mediamtxLive] = await Promise.all([
    getObsVersion().catch(() => null),
    fetchMediamtxVersion(),
  ]);
  const plugins = [];
  for (const meta of DEFAULT_PLUGINS) {
    const installed = pluginInstalled(meta.name);
    plugins.push({
      name: meta.name,
      version: meta.version,
      installed,
      loaded: installed ? await pluginLoaded(meta) : false,
    });
  }
  return {
    oink: require('./package.json').version,
    obs: (obs && obs.obsVersion) || readObsLastVersion(),
    obsWebSocket: obs ? obs.obsWebSocketVersion : null,
    mediamtx: mediamtxLive || binVersions.mediamtx || null,
    noalbs: binVersions.noalbs || null,
    srtlaRec: binVersions.srtla_rec || null,
    plugins,
    node: process.version,
    os: `${os.type()} ${os.release()}`,
    arch: os.arch(),
  };
}

function versionsToText(v) {
  const val = (x) => x || 'unknown';
  return [
    `OINK: ${v.oink || 'unknown'}`,
    `OBS Studio: ${val(v.obs)}`,
    `obs-websocket: ${val(v.obsWebSocket)}`,
    `MediaMTX: ${val(v.mediamtx)}`,
    `NOALBS: ${val(v.noalbs)}`,
    `SRTLA receiver: ${val(v.srtlaRec)}`,
    ...v.plugins.map((p) => `${p.name}: ${p.version}${p.installed ? '' : ' (not installed)'}`),
    `Node.js: ${v.node || 'unknown'}`,
    `OS: ${v.os} ${v.arch}`.trim(),
  ].join('\n') + '\n';
}

async function buildStatusSnapshot() {
  const triggers = status.readTriggers();
  const state = ingest.readState(STACK_DIR);
  const key = state && state.key ? state.key : null;
  const paths = key ? status.namespacePaths(await fetchMediamtxPaths(), key) : [];
  const { ingests, totalBitrate, next } = status.updateIngestRates(
    _statusPrevRates, paths, Date.now(),
  );
  _statusPrevRates = next;

  // Sequential (not Promise.all): both helpers call ensureObs(), which is not
  // safe to run concurrently on a cold bridge. OBS may be down — still emit.
  let scene = null;
  let outputStatus = {};
  try {
    scene = await getCurrentScene();
    outputStatus = await getStreamStatus();
  } catch {
    // OBS unreachable/unidentified; ingest feeds above are still valid.
  }

  return status.buildStatusUpdate({ ingests, totalBitrate, scene, outputStatus, triggers });
}

const statusTimer = setInterval(() => {
  if (statusClients.size === 0) return;
  buildStatusSnapshot()
    .then((snapshot) => {
      const msg = JSON.stringify(snapshot);
      for (const client of statusClients) {
        if (client.readyState === 1) client.send(msg);
      }
    })
    .catch((e) => console.error('[log-server] status broadcast failed:', e.message));
}, status.STATUS_INTERVAL_MS);
statusTimer.unref();

wss.on('connection', (ws, req) => {
  // Reject the log stream when control-plane auth is enabled and the handshake
  // carried no valid session cookie (browsers send same-origin cookies on the ws
  // upgrade automatically, so the dashboard works without extra client code).
  // Accounts stuck in the forced first-login rotation get the same treatment —
  // they may only use the password-change flow until they rotate.
  const wsUser = currentUser(req);
  if (!wsUser || wsUser.mustChangePassword) {
    ws.close(1008, 'unauthorized');
    return;
  }

  // Log streams can leak secrets from raw host/OBS output, so only operator+ may
  // open them; the /api/ws status snapshot stays open to any signed-in role.
  const wsPath = (req.url || '').split('?')[0];
  if (!canReadLogStream(wsUser.role, wsPath)) {
    ws.close(1008, 'forbidden');
    return;
  }

  // Controller status feed: register, send one snapshot immediately, unregister
  // on close. The shared interval above handles the 2.5s cadence.
  if (wsPath === '/api/ws') {
    statusClients.add(ws);
    ws.on('close', () => statusClients.delete(ws));
    buildStatusSnapshot()
      .then((snapshot) => {
        if (ws.readyState === 1) ws.send(JSON.stringify(snapshot));
      })
      .catch(() => {});
    return;
  }

  // Strip /api/logs/ prefix if present (Nginx proxies full path)
  let raw = req.url || '';
  raw = raw.replace(/^\/api\/logs\//, '').replace(/^\//, '');
  const service = raw.split('?')[0];

  if (service === 'obs') {
    console.log('[log-server] Client connected to obs');
    const logFile = getLatestObsLog();
    if (!logFile) {
      ws.send('No OBS log files found\n');
      ws.close();
      return;
    }
    ws.send(`Tailing: ${path.basename(logFile)}\n`);
    const tailProc = spawn('tail', ['-f', '-n', '100', logFile], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    tailProc.stdout.on('data', (data) => {
      for (const line of data.toString().split('\n').filter(Boolean)) {
        if (ws.readyState === 1) ws.send(line + '\n');
      }
    });
    tailProc.on('error', (err) => ws.send(`Error: ${err.message}\n`));
    tailProc.on('close', () => { ws.send('[DONE]'); ws.close(); });
    ws.on('close', () => { tailProc.kill(); });
    return;
  }

  if (serviceUnit(service)) {
    const unit = serviceUnit(service);
    console.log(`[log-server] Client connected to ${service}`);
    ws.send(`Connected to unit: ${unit}\n`);
    // -o cat emits bare message text (no journal metadata); -f follows,
    // -n 100 seeds the tail.
    const logProc = spawn('journalctl', ['-u', unit, '-n', '100', '-f', '-o', 'cat'], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    logProc.stdout.on('data', (data) => {
      for (const line of data.toString().split('\n').filter(Boolean)) {
        if (ws.readyState === 1) ws.send(line + '\n');
      }
    });
    logProc.stderr.on('data', (data) => {
      for (const line of data.toString().split('\n').filter(Boolean)) {
        if (ws.readyState === 1) ws.send(line + '\n');
      }
    });
    logProc.on('error', (err) => ws.send(`Error: ${err.message}\n`));
    logProc.on('close', () => { ws.send('[DONE]'); ws.close(); });
    ws.on('close', () => { logProc.kill(); });
    return;
  }

  ws.send(JSON.stringify({ error: `Unknown service: ${service}` }));
  ws.close();
});

function restartObsUnit() {
  execFileSync('systemctl', ['restart', 'oink-obs'], {
    encoding: 'utf-8',
    timeout: 60000,
  });
}

function stopObsUnit() {
  execFileSync('systemctl', ['stop', 'oink-obs'], {
    encoding: 'utf-8',
    timeout: 60000,
  });
}

function startObsUnit() {
  execFileSync('systemctl', ['start', 'oink-obs'], {
    encoding: 'utf-8',
    timeout: 60000,
  });
}

// Poll systemctl until oink-obs reports stopped — a reliable replacement for the
// old `pgrep -f 'obs --websocket'` substring probe, which could false-match.
function waitOBSStopped(timeoutMs = 10000) {
  return new Promise((resolve) => {
    const started = Date.now();
    const check = () => {
      let active = false;
      try {
        active = execFileSync('systemctl', ['is-active', 'oink-obs'], { encoding: 'utf-8', timeout: 3000 }).trim() === 'active';
      } catch {
        active = false;
      }
      if (!active || Date.now() - started >= timeoutMs) return resolve(!active);
      setTimeout(check, 100);
    };
    check();
  });
}

// Single, consistent success envelope for every response.
function json(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

// Single, consistent error envelope for every failure: { ok:false, error: <message> }.
// This is a JSON-only body; the HTTP status code carries the semantic (400/404/5xx).
function sendError(res, status, message) {
  json(res, status, { ok: false, error: message });
}

// For 5xx: log the underlying cause server-side (it may contain command output / stack)
// but return only a generic message to the client so internal details are not leaked.
function sendServerError(res, status, err, genericMessage) {
  console.error(`[log-server] ${status} ${genericMessage}:`, err);
  sendError(res, status, genericMessage);
}

function readBody(req, maxBytes = JSON_MAX_BYTES) {
  return new Promise((resolve, reject) => {
    let body = '';
    let size = 0;
    let tooBig = false;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > maxBytes) {
        tooBig = true;
        return; // keep draining the socket, but drop the payload
      }
      body += chunk;
    });
    req.on('end', () => {
      if (tooBig) reject(new InputError('Request body too large'));
      else resolve(body);
    });
    req.on('error', reject);
  });
}

// Parse a JSON request body (rejects with InputError on bad JSON/oversize).
function readJson(req, maxBytes = JSON_MAX_BYTES) {
  return readBody(req, maxBytes).then((body) => {
    try {
      return JSON.parse(body);
    } catch {
      throw new InputError('Request body must be valid JSON');
    }
  });
}

// systemctl with sane defaults (throws on failure).
function systemctl(action, unit, { timeout = 5000 } = {}) {
  return execFileSync('systemctl', [action, unit], { encoding: 'utf-8', timeout });
}

// systemctl is-active exits non-zero when the unit isn't active; its stdout still
// carries the state. Never throws.
function isUnitActive(unit) {
  try {
    return systemctl('is-active', unit, { timeout: 5000 }).trim() === 'active';
  } catch (e) {
    return String(e?.stdout ?? '').trim() === 'active';
  }
}

// One shared ffmpeg for every preview viewer: v4l2loopback tolerates multiple
// readers, but a second MJPEG encode for the same frames is pure waste. The
// first viewer spawns the encoder, later viewers join the same stdout, and it
// dies when the last viewer disconnects. The OBS virtual camera is likewise
// demand-driven: started when the first viewer arrives, stopped after a short
// grace once the last leaves — so an unwatched dashboard costs nothing and
// stream settings stay editable. Gated on welcome completion so onboarding's
// video-quality step isn't blocked by an active output. `ponytail:` fan-out
// ignores per-socket backpressure; fine for a few local viewers, drop slow
// consumers if that ever changes.
const PREVIEW_STOP_GRACE_MS = 5000;
const PREVIEW_DEVICE_WAIT_MS = 5000;
const preview = { child: null, subs: new Set(), stopTimer: null };

function previewStop() {
  const child = preview.child;
  preview.child = null;
  if (!child) return;
  try { child.kill('SIGKILL'); } catch { /* already gone */ }
}

function scheduleVirtualCamStop() {
  if (preview.stopTimer) clearTimeout(preview.stopTimer);
  preview.stopTimer = setTimeout(() => {
    preview.stopTimer = null;
    if (preview.subs.size > 0) return;
    vcamState.setWanted(STACK_DIR, false);
    void stopVirtualCam().catch(() => {});
  }, PREVIEW_STOP_GRACE_MS);
}

function cancelVirtualCamStop() {
  if (preview.stopTimer) {
    clearTimeout(preview.stopTimer);
    preview.stopTimer = null;
  }
}

function previewFail(message) {
  const subs = [...preview.subs];
  preview.subs.clear();
  for (const sub of subs) {
    if (!sub.started && !sub.res.headersSent) sendError(sub.res, 503, message);
    else sub.res.end();
  }
  previewStop();
}

// Wait for the v4l2loopback device OBS feeds to appear, so ffmpeg's first read
// doesn't race a just-started virtual camera.
function waitForPreviewDevice(timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve) => {
    const poll = () => {
      if (fs.existsSync(PREVIEW_DEVICE) || Date.now() >= deadline) resolve();
      else setTimeout(poll, 200);
    };
    poll();
  });
}

async function streamPreview(res) {
  if (!dashboardSettings.readSettings(STACK_DIR).welcomeComplete) {
    return sendError(res, 503, 'Finish setup to enable the preview');
  }

  // Let the first stdout write flush these headers; if ffmpeg never writes we
  // can still answer 503 above. `end: false` keeps stdout end from pre-empting
  // that error path.
  res.setHeader('Content-Type', `multipart/x-mixed-replace; boundary=${PREVIEW_BOUNDARY}`);
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Accel-Buffering', 'no');

  const sub = { res, started: false };
  const drop = () => {
    preview.subs.delete(sub);
    if (preview.subs.size === 0) {
      previewStop();
      scheduleVirtualCamStop();
    }
  };
  res.on('close', drop);
  preview.subs.add(sub);
  cancelVirtualCamStop();

  if (preview.child) return; // already encoding for other viewers

  // Demand-driven: only the preview needs the virtual camera, so start it here
  // instead of on every API boot (which would block stream-settings changes).
  try {
    await startVirtualCam();
    vcamState.setWanted(STACK_DIR, true);
  } catch (e) {
    return previewFail(`Preview feed unavailable: ${e.message}`);
  }
  await waitForPreviewDevice(PREVIEW_DEVICE_WAIT_MS);
  // Viewers may have left, or another viewer spawned, while we were starting.
  if (preview.subs.size === 0 || preview.child) return;

  const child = spawn('ffmpeg', [
    '-loglevel', 'error',
    '-f', 'v4l2', '-i', PREVIEW_DEVICE,
    '-vf', `scale=${PREVIEW_WIDTH}:-2,fps=${PREVIEW_FPS}`,
    '-c:v', 'mjpeg', '-q:v', String(PREVIEW_QUALITY),
    '-f', 'mpjpeg', '-boundary_tag', PREVIEW_BOUNDARY, 'pipe:1',
  ], { stdio: ['ignore', 'pipe', 'ignore'] });
  preview.child = child;
  child.stdout.on('data', (chunk) => {
    for (const s of preview.subs) {
      s.started = true;
      s.res.write(chunk);
    }
  });
  child.on('error', (e) => previewFail(`Preview encoder unavailable: ${e.message}`));
  child.on('exit', () => previewFail('Preview feed unavailable (OBS virtual camera off?)'));
}

// Run a route handler, mapping errors to responses: InputError → input status,
// BusyError → busy status, everything else → a logged generic server error.
async function handleApi(
  res,
  fn,
  { input = 400, busy = 409, server = 502, generic = 'Request failed' } = {},
) {
  try {
    await fn();
  } catch (e) {
    if (e instanceof InputError) return sendError(res, input, e.message);
    if (e instanceof BusyError) return sendError(res, busy, e.message);
    return sendServerError(res, server, e, generic);
  }
}

// The setup wipes the OBS "Untitled" profile, but the Aitum plugin keeps a config
// entry per profile it has ever seen — "Untitled" from OBS's first run lingers
// forever. Keep only entries matching a real OBS profile directory; if the dir
// can't be read, fall back to dropping "Untitled" alone.
function pruneStaleMultistreamProfiles(config) {
  const profilesDir = path.join(path.dirname(OBS_LOG_DIR), 'basic', 'profiles');
  let valid = new Set();
  try {
    valid = new Set(
      fs.readdirSync(profilesDir).filter((n) => fs.statSync(path.join(profilesDir, n)).isDirectory()),
    );
  } catch {
    valid = new Set();
  }
  const pruned = [];
  config.profiles = (config.profiles || []).filter((p) => {
    const keep = valid.size > 0 ? valid.has(p.name) : p.name !== 'Untitled';
    if (!keep) pruned.push(p.name);
    return keep;
  });
  return pruned;
}

// OBS-dependent seeds retry until OBS is up (oink-api can start before it).
function retrySeed(label, fn) {
  let attempt = 0;
  const run = async () => {
    attempt += 1;
    try {
      await fn();
    } catch (e) {
      if (attempt < 12) setTimeout(run, 10000);
      else console.log(`[log-server] ${label} seed skipped: ${e.message}`);
    }
  };
  run();
}

// Seed the dashboard settings store from the OINK_* env on first boot: the
// Twitch channel name (dashboard.json) and the video preset (applied to OBS).
// Seed-once — later dashboard edits are never clobbered by a setup re-run. When
// every welcome field is env-provided (channel + a stream key + preset) the
// first-run welcome screen is skipped.
function seedDashboardFromEnv() {
  const isNew = !fs.existsSync(dashboardSettings.settingsPath(STACK_DIR));
  const envChannel = (process.env.OINK_TWITCH_CHANNEL || '').trim();
  const presetName = (process.env.OINK_VIDEO_PRESET || '').trim();
  const keysProvided = ['TWITCH', 'YOUTUBE', 'KICK'].some(
    (p) => (process.env[`OINK_${p}_STREAM_KEY`] || '').trim(),
  );
  const hasChannel = !!envChannel && dashboardSettings.CHANNEL_RE.test(envChannel);
  const hasPreset = dashboardSettings.isValidPreset(presetName);
  try {
    dashboardSettings.ensureSettings(STACK_DIR, {
      twitchChannel: hasChannel ? envChannel : '',
      presetProvided: hasPreset,
      welcomeComplete: hasChannel && keysProvided && hasPreset,
    });
  } catch (e) {
    console.log(`[log-server] dashboard settings seed skipped: ${e.message}`);
    return;
  }
  if (!isNew || !hasPreset) return;
  const preset = dashboardSettings.VIDEO_PRESETS[presetName];
  retrySeed('video preset', async () => {
    const current = await getStreamSettings();
    await setStreamSettings({
      encoder: current.encoder || 'x264',
      outputWidth: preset.outputWidth,
      outputHeight: preset.outputHeight,
      fpsNumerator: preset.fps,
      fpsDenominator: 1,
      bitrate: preset.bitrate,
    });
    console.log(`[log-server] seeded video preset ${presetName} from OINK_* env`);
  });
}

// Seed platform stream outputs + primary platform from the OINK_* env the
// installer provisioned (cloud-init conf → api.env → systemd EnvironmentFile).
// Re-applied idempotently every start (oink-api.service runs after oink-obs), so
// conf changes converge. The primary platform streams via OBS's native output
// and the two non-primary ones via the Aitum Multistream plugin — the primary
// must never also appear in the plugin config (double-publish).
//
// Aitum only reads its config at OBS start and can overwrite it on shutdown, so
// a config change reuses the dashboard's stop→write→start cycle
// (PUT /api/obs/multistream/keys). Otherwise the plugin never activates the
// seeded outputs.
async function seedStreamConfigFromEnv() {
  const desired = {};
  for (const platform of ['twitch', 'youtube', 'kick']) {
    const key = (process.env[`OINK_${platform.toUpperCase()}_STREAM_KEY`] || '').trim();
    if (key) desired[platform] = key;
  }
  const primary = (process.env.OINK_PRIMARY_PLATFORM || '').trim().toLowerCase();
  const havePrimary = Object.prototype.hasOwnProperty.call(PLATFORMS, primary);
  if (Object.keys(desired).length === 0 && !havePrimary) return;

  const msKeys = {};
  for (const [platform, key] of Object.entries(desired)) {
    if (!(havePrimary && platform === primary)) msKeys[platform] = key;
  }

  try {
    let config = null;
    let needsWrite = false;
    let cleanPrimary = false;
    if (Object.keys(msKeys).length || havePrimary) {
      config = readMultistreamConfig();
      const state = multistreamKeyState(config);
      needsWrite = Object.entries(msKeys).some(
        ([p, v]) => !state[p] || !state[p].configured || state[p].last4 !== v.slice(-4),
      );
      // A lingering primary entry (it moved to native output) must be removed.
      cleanPrimary = havePrimary && !!(state[primary] && state[primary].configured);
    }
    const prunedNames = config ? pruneStaleMultistreamProfiles(config) : [];
    if (config && (needsWrite || cleanPrimary || prunedNames.length)) {
      try {
        stopObsUnit();
        await waitOBSStopped(10000);
      } catch (e) {
        console.log(`[log-server] multistream env seed: could not stop OBS (${e.message}); writing anyway`);
      }
      if (cleanPrimary) removePlatformFromMultistream(config, primary);
      if (Object.keys(msKeys).length) applyMultistreamKeys(config, msKeys);
      writeMultistreamConfig(config);
      if (prunedNames.length) {
        console.log(`[log-server] pruned stale Aitum multistream profile(s): ${prunedNames.join(', ')}`);
      }
      console.log('[log-server] seeded Aitum multistream keys from OINK_* env');
      try {
        startObsUnit();
        console.log('[log-server] restarted oink-obs to load multistream config');
      } catch (e) {
        console.log(`[log-server] multistream env seed: OBS restart failed (${e.message})`);
      }
    }
  } catch (e) {
    console.log(`[log-server] multistream env seed skipped: ${e.message}`);
  }

  if (!havePrimary) return;

  // Primary platform uses OBS's native output (websocket); after a restart the
  // socket may take a moment to come back, so retry briefly.
  retrySeed('primary platform env', async () => {
    const current = await getPrimaryPlatform();
    if (current !== primary) await setPrimaryPlatform(primary, '');
    if (desired[primary]) await setStreamServiceKey(desired[primary]);
    console.log(`[log-server] seeded primary platform=${primary} (key set) from OINK_* env`);
  });
}

server.listen(PORT, API_BIND_HOST, () => {
  console.log(`[log-server] Listening on ${API_BIND_HOST}:${PORT}`);
  seedStreamConfigFromEnv();
  seedDashboardFromEnv();
});
