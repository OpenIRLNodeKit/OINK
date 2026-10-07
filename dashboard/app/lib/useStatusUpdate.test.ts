// SPDX-FileCopyrightText: 2026 OpenIRLNodeKit contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
import { act, renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

const hookState = vi.hoisted(() => ({
  onMessage: undefined as ((data: unknown) => void) | undefined,
  status: 'connected' as string,
}));

vi.mock('./useWebSocket', () => ({
  useWebSocket: (
    _path: string,
    opts: { onMessage?: (data: unknown) => void },
  ) => {
    hookState.onMessage = opts?.onMessage;
    return { status: hookState.status, reconnect: () => {} };
  },
}));

import {
  type IngestSeries,
  mergeFeedList,
  mergeIngests,
  parseStatusMessage,
  pushSample,
  STATUS_MAX_SAMPLES,
  type StatusPacket,
  useStatusUpdate,
} from './useStatusUpdate';

function packet(
  feeds: { id: string; bitrate: number; ready?: boolean }[],
  main?: string,
): Record<string, unknown> {
  return {
    type: 'OpenIRLNodeKitStatusUpdate',
    ingests: feeds.map((f) => ({
      id: f.id,
      name: `live/k/${f.id}`,
      type: 'srtConn',
      media_state:
        f.ready === false ? 'OBS_MEDIA_STATE_NONE' : 'OBS_MEDIA_STATE_PLAYING',
      router_bitrate: f.bitrate,
    })),
    main_ingest_id: main ?? feeds[0]?.id ?? null,
    ingest_bitrate: feeds.reduce((sum, f) => sum + f.bitrate, 0),
    low_bitrate_trigger: 900,
    offline_bitrate_trigger: 300,
    scene: 'main',
    output_status: { stream_status: true, stream_timecode: '00:00:01.000' },
  };
}

describe('pushSample', () => {
  it('appends until capacity, then drops the oldest', () => {
    let history: number[] = [];
    for (let i = 0; i < 4; i += 1) history = pushSample(history, i, 3);
    expect(history).toEqual([1, 2, 3]);
    expect(STATUS_MAX_SAMPLES).toBe(120);
  });
});

describe('parseStatusMessage', () => {
  it('flattens every feed plus the global fields', () => {
    const parsed = parseStatusMessage(
      packet(
        [
          { id: 'stream', bitrate: 0, ready: false },
          { id: 'test', bitrate: 4200 },
        ],
        'test',
      ),
    );
    expect(parsed).toMatchObject({
      mainIngestId: 'test',
      scene: 'main',
      low: 900,
      offline: 300,
    });
    expect(parsed?.feeds).toEqual([
      { id: 'stream', ready: false, bitrate: 0 },
      { id: 'test', ready: true, bitrate: 4200 },
    ]);
  });

  it('ignores foreign frames and tolerates an empty feed list', () => {
    expect(parseStatusMessage({ type: 'SomethingElse' })).toBeNull();
    expect(parseStatusMessage(null)).toBeNull();
    const empty = parseStatusMessage({
      type: 'OpenIRLNodeKitStatusUpdate',
      ingests: [],
    });
    expect(empty?.feeds).toEqual([]);
  });
});

describe('mergeIngests', () => {
  const base: StatusPacket = {
    feeds: [],
    mainIngestId: null,
    scene: null,
    low: null,
    offline: null,
  };

  it('appends a sample per feed and keeps a stopped feed offline', () => {
    const first = mergeIngests(
      [],
      {
        ...base,
        feeds: [
          { id: 'a', ready: true, bitrate: 1000 },
          { id: 'b', ready: true, bitrate: 500 },
        ],
      },
      1000,
    );
    expect(first.map((s) => s.id)).toEqual(['a', 'b']);

    const second = mergeIngests(
      first,
      {
        ...base,
        feeds: [{ id: 'a', ready: true, bitrate: 1200 }],
      },
      3500,
    );

    const a = second.find((s) => s.id === 'a');
    const b = second.find((s) => s.id === 'b');
    expect(a?.history.map((s) => s.bitrate)).toEqual([1000, 1200]);
    expect(b?.ready).toBe(false);
    expect(b?.bitrate).toBe(0);
    expect(b?.history.map((s) => s.bitrate)).toEqual([500]);
  });
});

describe('mergeFeedList', () => {
  const feed = (
    id: string,
    ready: boolean,
    bitrate: number,
    history: { t: number; bitrate: number }[] = [],
  ): IngestSeries => ({ id, ready, bitrate, history });

  it('adds an offline placeholder for a saved profile with no live data', () => {
    const list = mergeFeedList(
      [feed('test', true, 1000, [{ t: 0, bitrate: 1000 }])],
      ['test', 'angle1'],
    );
    expect(list.find((f) => f.id === 'angle1')).toMatchObject({
      ready: false,
      bitrate: 0,
      history: [],
    });
  });

  it('keeps a live feed that was never saved as a profile', () => {
    const list = mergeFeedList(
      [feed('adhoc', true, 500, [{ t: 0, bitrate: 500 }])],
      [],
    );
    expect(list.some((f) => f.id === 'adhoc')).toBe(true);
  });

  it('hides the idle reserved irl path unless it carried data or is saved', () => {
    // Idle and never carried data (even with zero-valued samples) -> hidden.
    expect(
      mergeFeedList([feed('irl', false, 0)], []).some((f) => f.id === 'irl'),
    ).toBe(false);
    expect(
      mergeFeedList([feed('irl', false, 0, [{ t: 0, bitrate: 0 }])], []).some(
        (f) => f.id === 'irl',
      ),
    ).toBe(false);
    // Live, or previously live, or saved as a profile -> shown.
    expect(
      mergeFeedList([feed('irl', true, 10, [{ t: 0, bitrate: 10 }])], []).some(
        (f) => f.id === 'irl',
      ),
    ).toBe(true);
    expect(
      mergeFeedList([feed('irl', false, 0, [{ t: 0, bitrate: 50 }])], []).some(
        (f) => f.id === 'irl',
      ),
    ).toBe(true);
    expect(mergeFeedList([], ['irl']).some((f) => f.id === 'irl')).toBe(true);
  });
});

describe('useStatusUpdate', () => {
  it('tracks a series per ingest and exposes the global latest', () => {
    const { result } = renderHook(() => useStatusUpdate());
    expect(result.current.connected).toBe(true);

    act(() =>
      hookState.onMessage?.(packet([{ id: 'test', bitrate: 1000 }], 'test')),
    );
    act(() =>
      hookState.onMessage?.(packet([{ id: 'test', bitrate: 2000 }], 'test')),
    );

    expect(result.current.ingests).toHaveLength(1);
    expect(result.current.ingests[0].history.map((s) => s.bitrate)).toEqual([
      1000, 2000,
    ]);
    expect(result.current.latest?.scene).toBe('main');
    expect(result.current.mainIngestId).toBe('test');

    act(() => hookState.onMessage?.({ type: 'ignore' }));
    expect(result.current.ingests[0].history).toHaveLength(2);
  });
});
