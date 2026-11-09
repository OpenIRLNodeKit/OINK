// SPDX-FileCopyrightText: 2026 OpenIRLNodeKit contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  changePassword,
  completeSetup,
  createUser,
  fetchAuthStatus,
  listUsers,
  login,
  LOGOUT_KEY,
  logout,
  removeAvatar,
  resetUserPassword,
  setUserDisabled,
  uploadAvatar,
} from './auth';

function mockResponse(body: unknown, ok = true, status = ok ? 200 : 401) {
  return {
    ok,
    status,
    json: async () => body,
  } as Response;
}

const ADMIN_USER = {
  id: 'u1',
  username: 'admin',
  role: 'admin',
  disabled: false,
  mustChangePassword: false,
  createdAt: '2026-01-01T00:00:00.000Z',
  avatarUrl: null as string | null,
};

describe('auth client', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('reports enabled + unauthenticated when the server says so', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(mockResponse({ ok: false, enabled: true, user: null })),
    );
    await expect(fetchAuthStatus()).resolves.toEqual({
      ok: false,
      enabled: true,
      user: null,
    });
  });

  it('reports enabled + authenticated with the signed-in user', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(mockResponse({ ok: true, enabled: true, user: ADMIN_USER })),
    );
    await expect(fetchAuthStatus()).resolves.toEqual({
      ok: true,
      enabled: true,
      user: ADMIN_USER,
    });
  });

  it('treats a non-conforming response as auth-disabled (dev/e2e mock)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(mockResponse({ hello: 'index' })));
    await expect(fetchAuthStatus()).resolves.toEqual({
      ok: false,
      enabled: false,
      user: null,
    });
  });

  it('treats a network failure as auth-disabled', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')));
    await expect(fetchAuthStatus()).resolves.toEqual({
      ok: false,
      enabled: false,
      user: null,
    });
  });

  it('sends username+password and resolves ok on success', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(mockResponse({ ok: true, user: ADMIN_USER }));
    vi.stubGlobal('fetch', fetchMock);
    await expect(login('admin', 'secret')).resolves.toEqual({
      ok: true,
      user: ADMIN_USER,
    });
    const [, init] = fetchMock.mock.calls[0];
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body)).toEqual({ username: 'admin', password: 'secret' });
  });

  it('surfaces mustChangePassword on the login result for forced rotation', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        mockResponse({
          ok: true,
          user: { ...ADMIN_USER, mustChangePassword: true },
        }),
      ),
    );
    const result = await login('admin', 'seed-password');
    expect(result.ok).toBe(true);
    expect(result.user?.mustChangePassword).toBe(true);
  });

  it('surfaces the server error message on bad credentials', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        mockResponse({ ok: false, error: 'Invalid username or password' }, false, 401),
      ),
    );
    await expect(login('nobody', 'wrong')).resolves.toEqual({
      ok: false,
      error: 'Invalid username or password',
    });
  });

  it('reports a pending first-run setup', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        mockResponse({
          ok: false,
          enabled: true,
          user: null,
          setupRequired: true,
        }),
      ),
    );
    await expect(fetchAuthStatus()).resolves.toEqual({
      ok: false,
      enabled: true,
      user: null,
      setupRequired: true,
    });
  });

  it('completes setup with the token, username, and chosen password', async () => {
    const fetchMock = vi.fn().mockResolvedValue(mockResponse({ ok: true, user: ADMIN_USER }));
    vi.stubGlobal('fetch', fetchMock);
    await expect(
      completeSetup('setup-token', 'streamer', 'new-password'),
    ).resolves.toEqual({
      ok: true,
      user: ADMIN_USER,
    });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('/api/auth/setup');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body)).toEqual({
      token: 'setup-token',
      username: 'streamer',
      password: 'new-password',
    });
  });

  it('POSTs to logout without throwing on failure', async () => {
    const fetchMock = vi.fn().mockResolvedValue(mockResponse({ ok: true }));
    vi.stubGlobal('fetch', fetchMock);
    localStorage.removeItem(LOGOUT_KEY);
    await expect(logout()).resolves.toBeUndefined();
    expect(fetchMock.mock.calls[0][0]).toBe('/api/auth/logout');
    expect(fetchMock.mock.calls[0][1].method).toBe('POST');
    expect(localStorage.getItem(LOGOUT_KEY)).toBeTruthy();
  });

  it('rotates own password', async () => {
    const fetchMock = vi.fn().mockResolvedValue(mockResponse({ ok: true }));
    vi.stubGlobal('fetch', fetchMock);
    await expect(changePassword('old', 'newpass123')).resolves.toEqual({ ok: true });
    expect(fetchMock.mock.calls[0][0]).toBe('/api/auth/password');
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({
      oldPassword: 'old',
      newPassword: 'newpass123',
    });
  });

  it('lists users (admin)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(mockResponse({ ok: true, users: [ADMIN_USER] })),
    );
    await expect(listUsers()).resolves.toEqual({ ok: true, users: [ADMIN_USER] });
  });

  it('creates a user (admin)', async () => {
    const fetchMock = vi.fn().mockResolvedValue(mockResponse({ ok: true }));
    vi.stubGlobal('fetch', fetchMock);
    await expect(createUser('viewer1', 'viewer', 'longenough1')).resolves.toEqual({ ok: true });
    expect(fetchMock.mock.calls[0][0]).toBe('/api/auth/users');
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({
      username: 'viewer1',
      role: 'viewer',
      password: 'longenough1',
    });
  });

  it('resets a user password (admin)', async () => {
    const fetchMock = vi.fn().mockResolvedValue(mockResponse({ ok: true }));
    vi.stubGlobal('fetch', fetchMock);
    await expect(resetUserPassword('bob', 'newpass99')).resolves.toEqual({ ok: true });
    expect(fetchMock.mock.calls[0][0]).toBe('/api/auth/users/bob/reset');
  });

  it('toggles a user disabled state (admin)', async () => {
    const fetchMock = vi.fn().mockResolvedValue(mockResponse({ ok: true }));
    vi.stubGlobal('fetch', fetchMock);
    await expect(setUserDisabled('bob', true)).resolves.toEqual({ ok: true });
    expect(fetchMock.mock.calls[0][0]).toBe('/api/auth/users/bob/disabled');
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({ disabled: true });
  });

  it('uploads the avatar as a raw body with an X-Filename header', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        mockResponse({ ok: true, user: { ...ADMIN_USER, avatarUrl: '/api/auth/avatar?v=1' } }),
      );
    vi.stubGlobal('fetch', fetchMock);
    const file = new File(['abc'], 'pic.png', { type: 'image/png' });
    const result = await uploadAvatar(file);
    expect(result.ok).toBe(true);
    expect(result.user?.avatarUrl).toBe('/api/auth/avatar?v=1');
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('/api/auth/avatar');
    expect(init.method).toBe('POST');
    expect(init.body).toBe(file);
    expect(init.headers['X-Filename']).toBe('pic.png');
  });

  it('deletes the avatar and returns the updated user', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(mockResponse({ ok: true, user: { ...ADMIN_USER, avatarUrl: null } }));
    vi.stubGlobal('fetch', fetchMock);
    const result = await removeAvatar();
    expect(result.ok).toBe(true);
    expect(result.user?.avatarUrl).toBeNull();
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('/api/auth/avatar');
    expect(init.method).toBe('DELETE');
  });

  it('surfaces avatar upload failures', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(mockResponse({ ok: false, error: 'Avatar must be an image' }, false, 400)),
    );
    await expect(uploadAvatar(new File(['x'], 'a.txt', { type: 'text/plain' }))).resolves.toEqual({
      ok: false,
      error: 'Avatar must be an image',
    });
  });

  it('surfaces server errors from admin endpoints', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(mockResponse({ ok: false, error: 'Forbidden' }, false, 403)),
    );
    await expect(createUser('x', 'viewer', 'longenough1')).resolves.toEqual({
      ok: false,
      error: 'Forbidden',
    });
  });
});
