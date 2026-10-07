// SPDX-FileCopyrightText: 2026 OpenIRLNodeKit contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useNoalbs } from './useNoalbs';

function jsonResponse(body: unknown): Response {
  return {
    ok: true,
    status: 200,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as Response;
}

function installFetch(opts: {
  config?: unknown;
  running?: boolean;
}): ReturnType<typeof vi.fn> {
  const fn = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.includes('/api/config/noalbs')) {
      if (init?.method === 'PUT') return jsonResponse({ ok: true });
      return jsonResponse({ ok: true, content: opts.config ?? {} });
    }
    if (url.includes('/api/service/noalbs/status')) {
      return jsonResponse({ running: opts.running ?? false });
    }
    if (url.includes('/api/service/noalbs/')) return jsonResponse({ ok: true });
    return jsonResponse({ ok: true });
  });
  vi.stubGlobal('fetch', fn);
  return fn;
}

describe('useNoalbs', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('reads managed scenes from switchingScenes and reports active', async () => {
    installFetch({
      running: true,
      config: {
        switcher: {
          bitrateSwitcherEnabled: true,
          switchingScenes: { normal: 'a', low: 'b', offline: 'c' },
        },
      },
    });

    const { result } = renderHook(() => useNoalbs());

    await waitFor(() => expect(result.current.running).toBe(true));
    await waitFor(() =>
      expect(result.current.managedScenes).toEqual(['a', 'b', 'c']),
    );
    expect(result.current.enabled).toBe(true);
    expect(result.current.active).toBe(true);
  });

  it('falls back to the default managed scenes when config is empty', async () => {
    installFetch({ running: false, config: {} });

    const { result } = renderHook(() => useNoalbs());

    await waitFor(() => expect(result.current.running).toBe(false));
    expect(result.current.managedScenes).toEqual(['main', 'low-br', 'offline']);
    expect(result.current.active).toBe(false);
  });

  it('is inactive when the switcher is disabled even if the service runs', async () => {
    installFetch({
      running: true,
      config: {
        switcher: {
          bitrateSwitcherEnabled: false,
          switchingScenes: {
            normal: 'main',
            low: 'low-br',
            offline: 'offline',
          },
        },
      },
    });

    const { result } = renderHook(() => useNoalbs());

    await waitFor(() => expect(result.current.running).toBe(true));
    await waitFor(() => expect(result.current.enabled).toBe(false));
    expect(result.current.active).toBe(false);
  });

  it('starts the service on toggle(true) and starts a stop on toggle(false)', async () => {
    const fetchMock = installFetch({ running: false, config: {} });
    const { result } = renderHook(() => useNoalbs());
    await waitFor(() => expect(result.current.running).toBe(false));

    await act(async () => {
      await result.current.toggle(true);
    });
    await act(async () => {
      await result.current.toggle(false);
    });

    const urls = fetchMock.mock.calls.map((c) => String(c[0]));
    expect(urls).toContain('/api/service/noalbs/start');
    expect(urls).toContain('/api/service/noalbs/stop');
  });
});
