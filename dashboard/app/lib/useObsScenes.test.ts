// SPDX-FileCopyrightText: 2026 OpenIRLNodeKit contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useObsScenes } from './useObsScenes';

function mockResponse(body: unknown) {
  return { ok: true, json: async () => body } as Response;
}

describe('useObsScenes', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('loads scenes and current program scene on mount', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(
          mockResponse({
            ok: true,
            currentProgramScene: 'main',
            scenes: ['main', 'brb', 'offline'],
          }),
        ),
    );

    const { result } = renderHook(() => useObsScenes());

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.scenes).toEqual(['main', 'brb', 'offline']);
    expect(result.current.current).toBe('main');
    expect(result.current.error).toBeNull();
  });

  it('sets an error when the scene list request fails', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(mockResponse({ ok: false, error: 'OBS down' })),
    );

    const { result } = renderHook(() => useObsScenes());

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.error).toBe('OBS down');
  });

  it('updates the current scene after a successful switch', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        mockResponse({
          ok: true,
          currentProgramScene: 'main',
          scenes: ['main', 'brb'],
        }),
      )
      .mockResolvedValueOnce(mockResponse({ ok: true, sceneName: 'brb' }));
    vi.stubGlobal('fetch', fetchMock);

    const { result } = renderHook(() => useObsScenes());
    await waitFor(() => expect(result.current.loading).toBe(false));

    await act(async () => {
      await result.current.switchScene('brb');
    });

    expect(result.current.current).toBe('brb');
    expect(result.current.error).toBeNull();
    expect(result.current.pending).toBeNull();
  });

  it('surfaces a switch error and keeps the previous scene', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        mockResponse({
          ok: true,
          currentProgramScene: 'main',
          scenes: ['main', 'brb'],
        }),
      )
      .mockResolvedValueOnce(mockResponse({ ok: false, error: 'no such scene' }));
    vi.stubGlobal('fetch', fetchMock);

    const { result } = renderHook(() => useObsScenes());
    await waitFor(() => expect(result.current.loading).toBe(false));

    await act(async () => {
      await result.current.switchScene('nope');
    });

    expect(result.current.current).toBe('main');
    expect(result.current.error).toBe('no such scene');
    expect(result.current.pending).toBeNull();
  });
});
