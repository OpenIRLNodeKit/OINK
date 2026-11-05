'use strict';
// SPDX-FileCopyrightText: 2026 OpenIRLNodeKit contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * auth.js — accounts + roles for the OINK dashboard control plane.
 *
 * Single source of truth for three things log-server.js needs:
 *   1. Password hashing (scrypt, self-describing `scrypt$N$r$p$salt$hash` format)
 *   2. The box-local user store (~/oink/stack/users.json, 0600, atomic writes)
 *   3. HMAC-signed stateless session cookies, re-verified against the store on
 *      every request so disable/role/password changes apply immediately.
 *
 * Auth (and therefore login) is ONLY enforced when BOTH of these are set in the
 * unit environment (scripts/stack.py provisions both into 0600 api.env):
 *     OINK_SESSION_SECRET   — HMAC key for signing session cookies
 *     OINK_ADMIN_PASSWORD   — optional bootstrap password (unattended installs)
 *     OINK_SETUP_TOKEN      — one-time token for in-browser admin setup
 * OINK_ADMIN_PASSWORD and OINK_SETUP_TOKEN are never re-read after the admin
 * account is created.
 *
 * The module is the auth seam for a future control-plane: swapping the
 * password verifier for a service-issued-token verifier here leaves every route
 * handler in log-server.js untouched.
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const ROLES = Object.freeze({ ADMIN: 'admin', OPERATOR: 'operator', VIEWER: 'viewer' });
const VALID_ROLES = new Set([ROLES.ADMIN, ROLES.OPERATOR, ROLES.VIEWER]);
const BOOTSTRAP_USERNAME = 'admin';
const USERNAME_RE = /^[a-z0-9][a-z0-9-]{0,32}$/;
const MIN_PASSWORD_LEN = 8;

// Log streams expose raw host/OBS output that can carry secrets (obs-websocket
// password, stream keys), so journalctl + OBS tails require operator or admin.
// The controller status feed (/api/ws) is a snapshot, safe for any signed-in role.
function canReadLogStream(role, pathname) {
  const p = String(pathname || '').split('?')[0];
  if (p === '/api/ws') return true;
  return role === ROLES.ADMIN || role === ROLES.OPERATOR;
}

// scrypt params for new hashes (N=2^15, r=8, p=1, 64-byte key). The params are
// stored IN the hash string, so a future strength bump only affects new hashes.
// 128*N*r ~= 33.5 MiB of internal state, so maxmem must exceed the ~32 MiB
// Node default or scryptSync fails with ERR_CRYPTO_INVALID_SCRYPT_PARAMS.
const SCRYPT_PARAMS = { N: 1 << 15, r: 8, p: 1, keylen: 64, maxmem: 64 * 1024 * 1024 };

const SESSION_COOKIE = 'oink_session';
const CSRF_COOKIE = 'oink_csrf';
const SESSION_TTL_MS = 7 * 24 * 3600 * 1000; // 7 days
const HMAC_ALGO = 'sha256';

function usersPath(stackDir) {
  return path.join(stackDir, 'users.json');
}

function pendingResetPath(stackDir) {
  return path.join(stackDir, 'pending-reset.json');
}

// --- Password hashing ------------------------------------------------------

function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(String(password), salt, SCRYPT_PARAMS.keylen, SCRYPT_PARAMS);
  const b64 = (b) => b.toString('base64');
  return ['scrypt', SCRYPT_PARAMS.N, SCRYPT_PARAMS.r, SCRYPT_PARAMS.p, b64(salt), b64(hash)].join('$');
}

function parseHash(encoded) {
  const parts = String(encoded).split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return null;
  const N = Number(parts[1]);
  const r = Number(parts[2]);
  const p = Number(parts[3]);
  if (!Number.isInteger(N) || !Number.isInteger(r) || !Number.isInteger(p)) return null;
  if (N < 2 || r < 1 || p < 1) return null;
  try {
    return {
      N,
      r,
      p,
      salt: Buffer.from(parts[4], 'base64'),
      hash: Buffer.from(parts[5], 'base64'),
    };
  } catch {
    return null;
  }
}

function verifyPassword(password, encoded) {
  const spec = parseHash(encoded);
  if (!spec) return false;
  const candidate = crypto.scryptSync(String(password), spec.salt, spec.hash.length, {
    N: spec.N,
    r: spec.r,
    p: spec.p,
    maxmem: SCRYPT_PARAMS.maxmem,
  });
  return candidate.length === spec.hash.length && crypto.timingSafeEqual(candidate, spec.hash);
}

function safeEqual(a, b) {
  const left = Buffer.from(String(a || ''));
  const right = Buffer.from(String(b || ''));
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

// --- User store ------------------------------------------------------------

function emptyStore() {
  return { version: 1, users: [] };
}

function loadStore(stackDir) {
  const file = usersPath(stackDir);
  if (!fs.existsSync(file)) return emptyStore();
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf-8'));
    if (parsed && Array.isArray(parsed.users)) return parsed;
  } catch {
    // Corrupt store: fall back to an empty one. The API keeps running and the
    // operator can re-seed via `oink users reset`.
  }
  return emptyStore();
}

function saveStore(stackDir, store) {
  const file = usersPath(stackDir);
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(store, null, 2) + '\n', { mode: 0o600 });
  fs.renameSync(tmp, file);
}

function avatarUrlFor(user) {
  const meta = user.avatar && typeof user.avatar.updatedAt === 'number' ? user.avatar : null;
  if (!meta) return null;
  return `/api/auth/avatar?v=${meta.updatedAt}`;
}

function toPublicUser(user) {
  return {
    id: user.id,
    username: user.username,
    role: user.role,
    disabled: user.disabled === true,
    mustChangePassword: user.mustChangePassword === true,
    tokenVersion: Number(user.tokenVersion) || 0,
    createdAt: user.createdAt,
    avatarUrl: avatarUrlFor(user),
  };
}

// --- Session cookies -------------------------------------------------------

function signPayload(payload, secret) {
  const body = Buffer.from(JSON.stringify(payload), 'utf-8').toString('base64url');
  const sig = crypto.createHmac(HMAC_ALGO, secret).update(body).digest('base64url');
  return `${body}.${sig}`;
}

function verifyPayload(token, secret) {
  const dot = String(token).indexOf('.');
  if (dot === -1) return null;
  const body = String(token).slice(0, dot);
  const sig = String(token).slice(dot + 1);
  const expected = crypto.createHmac(HMAC_ALGO, secret).update(body).digest('base64url');
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf-8'));
    return typeof payload === 'object' && payload !== null ? payload : null;
  } catch {
    return null;
  }
}

function sessionTokenFromCookie(cookieHeader) {
  for (const part of String(cookieHeader || '').split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    if (part.slice(0, idx).trim() === SESSION_COOKIE) return part.slice(idx + 1).trim();
  }
  return null;
}

// `secure` is set only when the operator fronts the box with a TLS-terminating
// proxy (OINK_TRUSTED_PROXIES); over plain HTTP a Secure cookie would never be
// sent back, silently breaking login.
function sessionCookie(token, maxAgeSeconds, { secure = false } = {}) {
  return `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAgeSeconds}` +
    (secure ? '; Secure' : '');
}

// Double-submit CSRF cookie: deliberately NOT HttpOnly so the dashboard can
// read it and echo it in X-CSRF-Token. It is bound to the session because the
// same value is signed into the session payload (see issueSession/csrfFor), so
// an attacker-planted cookie alone cannot pass the server check.
function csrfCookie(value, maxAgeSeconds, { secure = false } = {}) {
  return `${CSRF_COOKIE}=${value}; Path=/; SameSite=Strict; Max-Age=${maxAgeSeconds}` +
    (secure ? '; Secure' : '');
}

// --- Account service -------------------------------------------------------

class AccountService {
  constructor({ stackDir, sessionSecret, adminPassword, adminPasswordOrigin = 'generated', setupToken = '', secureCookies = false }) {
    this.stackDir = stackDir;
    this.sessionSecret = sessionSecret || '';
    this.adminPassword = adminPassword || '';
    this.adminPasswordOrigin = adminPasswordOrigin === 'provided' ? 'provided' : 'generated';
    this.setupToken = setupToken || '';
    this.secureCookies = secureCookies === true;
    this._store = loadStore(stackDir);
    this._bootstrapAdmin();
    this._applyPendingResets();
    const hasStoreUsers = this._store.users.length > 0;
    // In-browser first-run setup: no accounts yet and no operator-provided
    // bootstrap password, so the one-time setup URL creates the admin.
    this.setupRequired = !hasStoreUsers && !this.adminPassword && Boolean(this.setupToken);
    // Dev/mock mode: no credentials and no accounts at all — log-server treats
    // every request as a local admin (Playwright mocks / local dev).
    const devMode = !this.sessionSecret && !this.adminPassword && !this.setupToken && !hasStoreUsers;
    this.enabled = !devMode && Boolean(this.sessionSecret) &&
      (hasStoreUsers || Boolean(this.adminPassword) || this.setupRequired);
    // Accounts or a secret exist but auth cannot run (e.g. OINK_SESSION_SECRET was
    // removed). Must fail closed: never silently fall back to an open local admin.
    this.misconfigured = !devMode && !this.enabled;
  }

  completeSetup(token, username, password) {
    // Re-read: a backup restore or another process may have created the admin
    // while this API was running. Never overwrite an existing account.
    this._store = loadStore(this.stackDir);
    if (this._store.users.length > 0) throw new UserError('Setup already completed');
    if (!this.setupToken || !safeEqual(token, this.setupToken)) {
      throw new UserError('Invalid setup token');
    }
    const normalized = String(username || BOOTSTRAP_USERNAME).trim().toLowerCase();
    if (!USERNAME_RE.test(normalized)) {
      throw new UserError('Username must be 1–33 chars: lowercase letters, digits, hyphens');
    }
    if (!verifyPasswordParam(password)) {
      throw new UserError(`Password must be at least ${MIN_PASSWORD_LEN} characters`);
    }
    const user = {
      id: crypto.randomUUID(),
      username: normalized,
      role: ROLES.ADMIN,
      salt: '',
      passwordHash: hashPassword(password),
      // The operator chose this password on the setup page: no forced rotation.
      mustChangePassword: false,
      createdAt: new Date().toISOString(),
      disabled: false,
    };
    this._store.users.push(user);
    saveStore(this.stackDir, this._store);
    // Consume the token in this process; the persisted token in api.env can no
    // longer be used because a user now exists.
    this.setupToken = '';
    this.setupRequired = false;
    console.log(`[auth] completed setup; created admin user "${normalized}"`);
    return toPublicUser(user);
  }

  _bootstrapAdmin() {
    // One-time seed: an empty store + OINK_ADMIN_PASSWORD creates the admin
    // user (hashed). The env value is never re-read for auth afterwards.
    if (this._store.users.length > 0 || !this.adminPassword) return;
    this._store.users.push({
      id: crypto.randomUUID(),
      username: BOOTSTRAP_USERNAME,
      role: ROLES.ADMIN,
      salt: '',
      passwordHash: hashPassword(this.adminPassword),
      // Force a first-login rotation unless the operator chose the password
      // themselves (OINK_ADMIN_PASSWORD_ORIGIN=provided). Auto-generated seeds
      // are shown once and are therefore "not chosen".
      mustChangePassword: this.adminPasswordOrigin !== 'provided',
      createdAt: new Date().toISOString(),
      disabled: false,
    });
    saveStore(this.stackDir, this._store);
    console.log(`[auth] bootstrapped admin user "${BOOTSTRAP_USERNAME}" ` +
      `(change the password after first login)`);
  }

  _applyPendingResets() {
    // `oink users reset` stages {username, password} here and restarts the API;
    // hashing happens only in this node process, so the CLI never re-implements
    // the scrypt format. The file is transient (deleted after applying).
    const file = pendingResetPath(this.stackDir);
    if (!fs.existsSync(file)) return;
    let pending = null;
    try {
      pending = JSON.parse(fs.readFileSync(file, 'utf-8'));
    } catch {
      fs.unlinkSync(file);
      return;
    }
    try {
      const user = this._store.users.find((u) => u.username === pending.username);
      if (user && verifyPasswordParam(pending.password)) {
        user.passwordHash = hashPassword(pending.password);
        // A reset password is generated by the CLI and shown once — the user
        // must rotate at their next sign-in, and any outstanding session dies.
        user.mustChangePassword = true;
        user.tokenVersion = (Number(user.tokenVersion) || 0) + 1;
        saveStore(this.stackDir, this._store);
        console.log(`[auth] applied pending password reset for "${pending.username}"`);
      } else if (!user) {
        console.log(`[auth] pending reset: no such user "${pending.username}"`);
      }
    } catch {
      console.log('[auth] pending reset: invalid payload; ignored');
    }
    fs.unlinkSync(file);
  }

  // Verified session payload for a request, or null (no/expired/bad signature).
  _payload(req) {
    const token = sessionTokenFromCookie(req?.headers?.cookie);
    if (!token) return null;
    const payload = verifyPayload(token, this.sessionSecret);
    if (!payload || typeof payload.exp !== 'number' || payload.exp < Date.now()) return null;
    return payload;
  }

  currentUser(req) {
    const payload = this._payload(req);
    if (!payload) return null;
    // Read the store fresh rather than the cached _store: a process may be
    // constructed before users.json exists (oink-guac starts just before
    // oink-api bootstraps the admin on a fresh install) or have it replaced
    // underneath it (backup restore). A stale snapshot would reject every
    // session until the process restarts. Also makes role/disable changes apply
    // immediately, as documented.
    const user = loadStore(this.stackDir).users.find((u) => u.id === payload.sub);
    if (!user || user.disabled) return null;
    // Reject tokens minted before a password change/disable (version bump).
    if ((Number(user.tokenVersion) || 0) !== (Number(payload.ver) || 0)) return null;
    return toPublicUser(user);
  }

  // CSRF token minted into the signed session at login; null when there is no
  // valid session or the token carries no csrf claim.
  csrfFor(req) {
    const payload = this._payload(req);
    return payload && typeof payload.csrf === 'string' ? payload.csrf : null;
  }

  authenticate(username, password) {
    if (!this.enabled) return null;
    const name = String(username || '').trim().toLowerCase();
    if (!name) return null;
    const user = this._store.users.find(
      (u) => u.username === name && !u.disabled,
    );
    if (!user || !verifyPassword(password || '', user.passwordHash)) return null;
    return toPublicUser(user);
  }

  issueSession(user, res) {
    const csrf = crypto.randomBytes(32).toString('base64url');
    const payload = {
      sub: user.id,
      role: user.role,
      csrf,
      // Session version: bumped on password change/disable so outstanding tokens
      // can be revoked server-side (a stolen cookie dies on rotation).
      ver: Number(user.tokenVersion) || 0,
      exp: Date.now() + SESSION_TTL_MS,
    };
    const token = signPayload(payload, this.sessionSecret);
    const maxAge = Math.floor(SESSION_TTL_MS / 1000);
    const opts = { secure: this.secureCookies };
    res.setHeader('Set-Cookie', [
      sessionCookie(token, maxAge, opts),
      csrfCookie(csrf, maxAge, opts),
    ]);
  }

  endSession(req, res) {
    const opts = { secure: this.secureCookies };
    res.setHeader('Set-Cookie', [
      sessionCookie('', 0, opts),
      csrfCookie('', 0, opts),
    ]);
  }

  listUsers() {
    return [...this._store.users]
      .sort((a, b) => a.username.localeCompare(b.username))
      .map(toPublicUser);
  }

  createUser({ username, role, password }) {
    const normalized = String(username || '').trim().toLowerCase();
    if (!USERNAME_RE.test(normalized)) {
      throw new UserError('Username must be 1–33 chars: lowercase letters, digits, hyphens');
    }
    if (!VALID_ROLES.has(role)) {
      throw new UserError('role must be "admin", "operator", or "viewer"');
    }
    if (!verifyPasswordParam(password)) {
      throw new UserError(`Password must be at least ${MIN_PASSWORD_LEN} characters`);
    }
    if (this._store.users.some((u) => u.username === normalized)) {
      throw new UserError(`User "${normalized}" already exists`);
    }
    const user = {
      id: crypto.randomUUID(),
      username: normalized,
      role,
      salt: '',
      passwordHash: hashPassword(password),
      // The admin chose this password when creating the account, so no
      // first-login rotation is forced.
      mustChangePassword: false,
      createdAt: new Date().toISOString(),
      disabled: false,
    };
    this._store.users.push(user);
    saveStore(this.stackDir, this._store);
    return toPublicUser(user);
  }

  setAvatar(username, meta) {
    const user = this._store.users.find((u) => u.username === username);
    if (!user) throw new UserError('No such user');
    user.avatar = { contentType: meta.contentType, updatedAt: Date.now() };
    saveStore(this.stackDir, this._store);
    return toPublicUser(user);
  }

  getAvatar(username) {
    const user = this._store.users.find((u) => u.username === username);
    return user && user.avatar && typeof user.avatar.updatedAt === 'number'
      ? { contentType: user.avatar.contentType, updatedAt: user.avatar.updatedAt }
      : null;
  }

  clearAvatar(username) {
    const user = this._store.users.find((u) => u.username === username);
    if (!user) throw new UserError('No such user');
    user.avatar = null;
    saveStore(this.stackDir, this._store);
    return toPublicUser(user);
  }

  changePassword(username, oldPassword, newPassword) {
    const user = this._store.users.find((u) => u.username === username);
    if (!user) throw new UserError('No such user');
    if (!verifyPassword(oldPassword || '', user.passwordHash)) {
      throw new UserError('Current password is incorrect');
    }
    if (!verifyPasswordParam(newPassword)) {
      throw new UserError(`New password must be at least ${MIN_PASSWORD_LEN} characters`);
    }
    user.passwordHash = hashPassword(newPassword);
    user.mustChangePassword = false;
    user.tokenVersion = (Number(user.tokenVersion) || 0) + 1;
    saveStore(this.stackDir, this._store);
  }

  resetPassword(username, newPassword) {
    const user = this._store.users.find((u) => u.username === username);
    if (!user) throw new UserError(`No user "${username}"`);
    if (!verifyPasswordParam(newPassword)) {
      throw new UserError(`Password must be at least ${MIN_PASSWORD_LEN} characters`);
    }
    user.passwordHash = hashPassword(newPassword);
    // Reset passwords are generated by the operator/CLI and shown once, so the
    // account must rotate at its next sign-in.
    user.mustChangePassword = true;
    user.tokenVersion = (Number(user.tokenVersion) || 0) + 1;
    saveStore(this.stackDir, this._store);
  }

  setUserDisabled(username, disabled) {
    const user = this._store.users.find((u) => u.username === username);
    if (!user) throw new UserError(`No user "${username}"`);
    if (disabled && user.role === ROLES.ADMIN) {
      const activeAdmins = this._store.users.filter(
        (u) => u.role === ROLES.ADMIN && !u.disabled,
      );
      if (activeAdmins.length <= 1) {
        throw new UserError('Cannot disable the last active admin');
      }
    }
    user.disabled = Boolean(disabled);
    user.tokenVersion = (Number(user.tokenVersion) || 0) + 1;
    saveStore(this.stackDir, this._store);
  }
}

function verifyPasswordParam(password) {
  return typeof password === 'string' && password.length >= MIN_PASSWORD_LEN;
}

class UserError extends Error {}

module.exports = {
  AccountService,
  ROLES,
  BOOTSTRAP_USERNAME,
  MIN_PASSWORD_LEN,
  canReadLogStream,
  sessionTokenFromCookie,
  verifyPassword,
  hashPassword,
};
