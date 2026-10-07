// SPDX-FileCopyrightText: 2026 OpenIRLNodeKit contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { formatResolution, useObsStreamSettings } from './useObsStreamSettings';

function mockResponse(body: unknown) {
  return { ok: true, json: async () => body } as Response;
}

const SETTINGS = {
  ok: true,
  encoder: 'x264',
  outputWidth: 1920,
  outputHeight: 1080,
  fpsNumerator: 60,
  fpsDenominator: 1,
  bitrate: 6000,
  hasNvenc: false,
  streamActive: false,
};

describe('formatResolution', () => {
  it('formats output height + rounded fps', () => {
    expect(
      formatResolution({
        outputWidth: 1920,
        outputHeight: 1080,
        fpsNumerator: 60,
        fpsDenominator: 1,
      }),
    ).toBe('1080p60');
    expect(
      formatResolution({
        outputWidth: 1280,
        outputHeight: 720,
        fpsNumerator: 60000,
        fpsDenominator: 1001,
      }),
    ).toBe('720p60');
    expect(
      formatResolution({
        outputWidth: 1280,
        outputHeight: 720,
        fpsNumerator: 30000,
        fpsDenominator: 1001,
      }),
    ).toBe('720p30');
  });

  it('returns null when settings are missing or empty', () => {
    expect(formatResolution(null)).toBeNull();
    expect(
      formatResolution({
        outputWidth: 0,
        outputHeight: 0,
        fpsNumerator: 0,
        fpsDenominator: 0,
      }),
    ).toBeNull();
  });
});

describe('useObsStreamSettings', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('loads settings and sets lastUpdated on mount', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(mockResponse(SETTINGS)));

    const { result } = renderHook(() => useObsStreamSettings());

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.settings?.outputWidth).toBe(1920);
    expect(result.current.settings?.bitrate).toBe(6000);
    expect(result.current.settings?.hasNvenc).toBe(false);
    expect(result.current.lastUpdated).toBeInstanceOf(Date);
    expect(result.current.error).toBeNull();
  });

  it('sets an error when loading fails', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(mockResponse({ ok: false, error: 'OBS down' })),
    );

    const { result } = renderHook(() => useObsStreamSettings());

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.error).toBe('OBS down');
  });

  it('updates settings after a successful save', async () => {
    const updated = { ...SETTINGS, outputWidth: 1280, outputHeight: 720, bitrate: 4500 };
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(mockResponse(SETTINGS))
      .mockResolvedValueOnce(mockResponse(updated));
    vi.stubGlobal('fetch', fetchMock);

    const { result } = renderHook(() => useObsStreamSettings());
    await waitFor(() => expect(result.current.loading).toBe(false));

    let ok = false;
    await act(async () => {
      ok = await result.current.save({
        encoder: 'x264',
        outputWidth: 1280,
        outputHeight: 720,
        fpsNumerator: 60,
        fpsDenominator: 1,
        bitrate: 4500,
      });
    });

    expect(ok).toBe(true);
    expect(result.current.settings?.outputHeight).toBe(720);
    expect(result.current.settings?.bitrate).toBe(4500);
  });

  it('surfaces a save error and returns false', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(mockResponse(SETTINGS))
      .mockResolvedValueOnce(mockResponse({ ok: false, error: 'Stop the stream first' }));
    vi.stubGlobal('fetch', fetchMock);

    const { result } = renderHook(() => useObsStreamSettings());
    await waitFor(() => expect(result.current.loading).toBe(false));

    let ok = true;
    await act(async () => {
      ok = await result.current.save({
        encoder: 'x264',
        outputWidth: 1920,
        outputHeight: 1080,
        fpsNumerator: 60,
        fpsDenominator: 1,
        bitrate: 6000,
      });
    });

    expect(ok).toBe(false);
    expect(result.current.saveError).toBe('Stop the stream first');
  });
});
