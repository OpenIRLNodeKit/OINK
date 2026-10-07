// SPDX-FileCopyrightText: 2026 OpenIRLNodeKit contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as api from './api';
import { useIngestControls } from './useIngestControls';

vi.mock('./api', () => ({
  getIngestControls: vi.fn(),
  setIngestMute: vi.fn(),
  setIngestVisible: vi.fn(),
  restartIngest: vi.fn(),
}));

const mockedGet = vi.mocked(api.getIngestControls);
const mockedMute = vi.mocked(api.setIngestMute);
const mockedVisible = vi.mocked(api.setIngestVisible);
const mockedRestart = vi.mocked(api.restartIngest);

const state = {
  name: 'test',
  muted: false,
  visible: true,
  restartable: true,
};

describe('useIngestControls', () => {
  beforeEach(() => {
    mockedGet.mockReset();
    mockedMute.mockReset();
    mockedVisible.mockReset();
    mockedRestart.mockReset();
    mockedGet.mockResolvedValue([state]);
    mockedMute.mockResolvedValue(undefined);
    mockedVisible.mockResolvedValue(undefined);
    mockedRestart.mockResolvedValue(undefined);
  });

  it('loads control state for the feeds', async () => {
    const { result } = renderHook(() => useIngestControls(['test']));
    await waitFor(() => expect(result.current.state.test).toMatchObject(state));
  });

  it('optimistically toggles mute', async () => {
    const { result } = renderHook(() => useIngestControls(['test']));
    await waitFor(() => expect(result.current.state.test).toBeDefined());
    await act(async () => {
      await result.current.toggleMute('test');
    });
    expect(mockedMute).toHaveBeenCalledWith('test', true);
    expect(result.current.state.test.muted).toBe(true);
  });

  it('optimistically toggles visibility', async () => {
    const { result } = renderHook(() => useIngestControls(['test']));
    await waitFor(() => expect(result.current.state.test).toBeDefined());
    await act(async () => {
      await result.current.toggleVisibility('test');
    });
    expect(mockedVisible).toHaveBeenCalledWith('test', false);
    expect(result.current.state.test.visible).toBe(false);
  });

  it('reverts and records an error when the OBS call fails', async () => {
    mockedMute.mockRejectedValueOnce(new Error('OBS is unreachable'));
    const { result } = renderHook(() => useIngestControls(['test']));
    await waitFor(() => expect(result.current.state.test).toBeDefined());
    await act(async () => {
      await result.current.toggleMute('test');
    });
    expect(result.current.state.test.muted).toBe(false);
    expect(result.current.error).toContain('OBS is unreachable');
  });

  it('ignores a toggle when the feed has no known control state', async () => {
    mockedGet.mockResolvedValue([]);
    const { result } = renderHook(() => useIngestControls(['ghost']));
    await waitFor(() => expect(mockedGet).toHaveBeenCalled());
    await act(async () => {
      await result.current.toggleMute('ghost');
    });
    expect(mockedMute).not.toHaveBeenCalled();
  });

  it('restarts a restartable feed and records failures', async () => {
    const { result } = renderHook(() => useIngestControls(['test']));
    await waitFor(() => expect(result.current.state.test).toBeDefined());
    await act(async () => {
      await result.current.restart('test');
    });
    expect(mockedRestart).toHaveBeenCalledWith('test');

    mockedRestart.mockRejectedValueOnce(new Error('OBS says no'));
    await act(async () => {
      await result.current.restart('test');
    });
    expect(result.current.error).toContain('OBS says no');
  });

  it('ignores restart for a non-restartable feed', async () => {
    mockedGet.mockResolvedValue([{ ...state, restartable: false }]);
    const { result } = renderHook(() => useIngestControls(['test']));
    await waitFor(() => expect(result.current.state.test).toBeDefined());
    await act(async () => {
      await result.current.restart('test');
    });
    expect(mockedRestart).not.toHaveBeenCalled();
  });
});
