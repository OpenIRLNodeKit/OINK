// SPDX-FileCopyrightText: 2026 OpenIRLNodeKit contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import {
  backoffDelay,
  resolveWebSocketUrl,
  useWebSocket,
} from './useWebSocket';

class MockWebSocket {
  static instances: MockWebSocket[] = [];
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;

  url: string;
  readyState = MockWebSocket.CONNECTING;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;

  constructor(url: string) {
    this.url = url;
    MockWebSocket.instances.push(this);
  }

  close() {
    this.readyState = MockWebSocket.CLOSED;
    this.onclose?.();
  }

  static emit(event: 'open' | 'close' | 'error' | 'message', data?: unknown) {
    for (const ws of MockWebSocket.instances) {
      if (event === 'open') {
        ws.readyState = MockWebSocket.OPEN;
        ws.onopen?.();
      } else if (event === 'close') {
        ws.readyState = MockWebSocket.CLOSED;
        ws.onclose?.();
      } else if (event === 'error') {
        ws.onerror?.();
      } else {
        ws.onmessage?.({ data });
      }
    }
  }
}

describe('useWebSocket helpers', () => {
  it('computes exponential backoff with a ceiling', () => {
    expect(backoffDelay(0)).toBe(1000);
    expect(backoffDelay(1)).toBe(2000);
    expect(backoffDelay(2)).toBe(4000);
    expect(backoffDelay(10)).toBe(15000);
  });

  it('resolves ws/wss URLs relative to the location protocol', () => {
    expect(resolveWebSocketUrl('/api/logs/obs')).toBe(
      `ws://localhost:${window.location.port}/api/logs/obs`,
    );
  });
});

describe('useWebSocket', () => {
  beforeEach(() => {
    MockWebSocket.instances = [];
    vi.stubGlobal('WebSocket', MockWebSocket);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('reports connecting then connected', async () => {
    const { result } = renderHook(() => useWebSocket('/api/logs/obs'));
    expect(result.current.status).toBe('connecting');
    MockWebSocket.emit('open');
    await waitFor(() => expect(result.current.status).toBe('connected'));
  });

  it('delivers parsed JSON messages to onMessage', async () => {
    const onMessage = vi.fn();
    renderHook(() => useWebSocket('/api/logs/obs', { onMessage }));
    MockWebSocket.emit('open');
    const payload = { type: 'ping' };
    MockWebSocket.emit('message', JSON.stringify(payload));
    await waitFor(() => expect(onMessage).toHaveBeenCalledWith(payload));
  });

  it('does not connect when disabled', () => {
    renderHook(() => useWebSocket('/api/logs/obs', { enabled: false }));
    expect(MockWebSocket.instances).toHaveLength(0);
  });

  it('retries with backoff after an unexpected close', async () => {
    vi.useFakeTimers();
    renderHook(() => useWebSocket('/api/logs/obs'));
    expect(MockWebSocket.instances).toHaveLength(1);
    MockWebSocket.emit('close');
    await vi.advanceTimersByTimeAsync(1000);
    expect(MockWebSocket.instances.length).toBeGreaterThan(1);
    await vi.advanceTimersByTimeAsync(4000);
    MockWebSocket.emit('close');
    await vi.advanceTimersByTimeAsync(2000);
    expect(MockWebSocket.instances.length).toBeGreaterThan(2);
  });

  it('reconnects manually after a close', async () => {
    vi.useFakeTimers();
    const { result } = renderHook(() => useWebSocket('/api/logs/obs'));
    expect(MockWebSocket.instances).toHaveLength(1);
    act(() => result.current.reconnect());
    await vi.advanceTimersByTimeAsync(1000);
    expect(MockWebSocket.instances.length).toBeGreaterThan(1);
  });
});
