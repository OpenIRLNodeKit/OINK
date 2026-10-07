// SPDX-FileCopyrightText: 2026 OpenIRLNodeKit contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
import { csrfHeaders } from './csrf';

export type Role = 'admin' | 'operator' | 'viewer';

export interface AuthUser {
  id: string;
  username: string;
  role: Role;
  disabled: boolean;
  mustChangePassword?: boolean;
  createdAt: string;
  avatarUrl?: string | null;
}

export interface AuthStatus {
  ok: boolean;
  enabled: boolean;
  user: AuthUser | null;
}

export interface AuthResult {
  ok: boolean;
  error?: string;
  user?: AuthUser | null;
}

interface JsonBody {
  ok?: unknown;
  error?: unknown;
  user?: unknown;
  enabled?: unknown;
  users?: unknown;
}

const STATUS_TIMEOUT_MS = 3000;

// Cross-tab logout signal. The session cookie is browser-wide, so any already-open
// page (notably /remote, which holds a live VNC WebSocket) must tear itself down
// when another tab signs out. Mirrored by scripts/templates/client.html.
export const LOGOUT_KEY = 'oink_logout';

export async function fetchAuthStatus(): Promise<AuthStatus> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), STATUS_TIMEOUT_MS);
  try {
    const res = await fetch('/api/auth/status', {
      credentials: 'same-origin',
      signal: controller.signal,
    });
    const data = (await res.json().catch(() => null)) as {
      ok?: unknown;
      enabled?: unknown;
      user?: unknown;
    } | null;
    // Any non-conforming response means "auth is not enforced" (e.g. the mocked
    // Playwright server, which has no /api/auth/*). Only an explicit 401 from a
    // server that reports auth enabled should trigger a login redirect.
    if (!data || typeof data.ok !== 'boolean' || typeof data.enabled !== 'boolean') {
      return { ok: false, enabled: false, user: null };
    }
    if (!data.ok || !data.enabled) {
      return { ok: data.ok, enabled: data.enabled, user: null };
    }
    return { ok: true, enabled: true, user: parseUser(data.user) };
  } catch {
    return { ok: false, enabled: false, user: null };
  } finally {
    clearTimeout(timer);
  }
}

export async function login(username: string, password: string): Promise<AuthResult> {
  try {
    const res = await fetch('/api/auth/login', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password }),
    });
    const data = (await res.json().catch(() => null)) as JsonBody | null;
    if (res.ok && data?.ok) {
      return { ok: true, user: parseUser(data.user) };
    }
    return {
      ok: false,
      error:
        typeof data?.error === 'string' && data.error
          ? data.error
          : `Sign-in failed (HTTP ${res.status})`,
    };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : 'Sign-in failed' };
  }
}

export async function logout(): Promise<void> {
  // Signal other same-origin tabs before the request: best-effort, even if the
  // server call fails the browser is signed out.
  try {
    localStorage.setItem(LOGOUT_KEY, String(Date.now()));
  } catch {
    // no localStorage (SSR/tests): nothing to notify
  }
  try {
    await fetch('/api/auth/logout', {
      method: 'POST',
      credentials: 'same-origin',
      headers: csrfHeaders(),
    });
  } catch {
    // best-effort: the client navigates away regardless
  }
}

export async function changePassword(
  oldPassword: string,
  newPassword: string,
): Promise<AuthResult> {
  try {
    const res = await fetch('/api/auth/password', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json', ...csrfHeaders() },
      body: JSON.stringify({ oldPassword, newPassword }),
    });
    const data = (await res.json().catch(() => null)) as JsonBody | null;
    if (res.ok && data?.ok) return { ok: true };
    return {
      ok: false,
      error:
        typeof data?.error === 'string' && data.error
          ? data.error
          : `Password change failed (HTTP ${res.status})`,
    };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : 'Password change failed' };
  }
}

export async function listUsers(): Promise<{ ok: boolean; users?: AuthUser[]; error?: string }> {
  try {
    const res = await fetch('/api/auth/users', { credentials: 'same-origin' });
    const data = (await res.json().catch(() => null)) as JsonBody | null;
    if (res.ok && data?.ok && Array.isArray(data.users)) {
      return { ok: true, users: data.users.map(parseUser).filter(Boolean) as AuthUser[] };
    }
    return {
      ok: false,
      error: typeof data?.error === 'string' ? data.error : `Failed to list users (HTTP ${res.status})`,
    };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : 'Failed to list users' };
  }
}

export async function createUser(
  username: string,
  role: Role,
  password: string,
): Promise<AuthResult> {
  return postUserEndpoint('/api/auth/users', { username, role, password });
}

export async function resetUserPassword(
  username: string,
  password: string,
): Promise<AuthResult> {
  return postUserEndpoint(`/api/auth/users/${encodeURIComponent(username)}/reset`, { password });
}

export async function setUserDisabled(
  username: string,
  disabled: boolean,
): Promise<AuthResult> {
  return postUserEndpoint(`/api/auth/users/${encodeURIComponent(username)}/disabled`, { disabled });
}

export async function uploadAvatar(file: File): Promise<AuthResult> {
  try {
    const res = await fetch('/api/auth/avatar', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'X-Filename': file.name, ...csrfHeaders() },
      body: file,
    });
    const data = (await res.json().catch(() => null)) as JsonBody | null;
    if (res.ok && data?.ok) return { ok: true, user: parseUser(data.user) };
    return {
      ok: false,
      error: typeof data?.error === 'string' ? data.error : `Upload failed (HTTP ${res.status})`,
    };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : 'Upload failed' };
  }
}

export async function removeAvatar(): Promise<AuthResult> {
  try {
    const res = await fetch('/api/auth/avatar', {
      method: 'DELETE',
      credentials: 'same-origin',
      headers: csrfHeaders(),
    });
    const data = (await res.json().catch(() => null)) as JsonBody | null;
    if (res.ok && data?.ok) return { ok: true, user: parseUser(data.user) };
    return {
      ok: false,
      error: typeof data?.error === 'string' ? data.error : `Remove failed (HTTP ${res.status})`,
    };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : 'Remove failed' };
  }
}

async function postUserEndpoint(path: string, body: unknown): Promise<AuthResult> {
  try {
    const res = await fetch(path, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json', ...csrfHeaders() },
      body: JSON.stringify(body),
    });
    const data = (await res.json().catch(() => null)) as JsonBody | null;
    if (res.ok && data?.ok) return { ok: true };
    return {
      ok: false,
      error: typeof data?.error === 'string' ? data.error : `Request failed (HTTP ${res.status})`,
    };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : 'Request failed' };
  }
}

function parseUser(value: unknown): AuthUser | null {
  if (!value || typeof value !== 'object') return null;
  const u = value as Record<string, unknown>;
  if (typeof u.id !== 'string' || typeof u.username !== 'string') return null;
  if (u.role !== 'admin' && u.role !== 'operator' && u.role !== 'viewer') return null;
  return {
    id: u.id,
    username: u.username,
    role: u.role,
    disabled: u.disabled === true,
    mustChangePassword: u.mustChangePassword === true,
    createdAt: typeof u.createdAt === 'string' ? u.createdAt : '',
    avatarUrl: typeof u.avatarUrl === 'string' ? u.avatarUrl : null,
  };
}
