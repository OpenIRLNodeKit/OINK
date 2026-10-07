// SPDX-FileCopyrightText: 2026 OpenIRLNodeKit contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen } from '@testing-library/react';
import LogViewer from './LogViewer';

class MockWebSocket {
  static instances: MockWebSocket[] = [];

  url: string;
  readyState = 0;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;

  constructor(url: string) {
    this.url = url;
    MockWebSocket.instances.push(this);
  }

  close() {
    this.readyState = 3;
    this.onclose?.();
  }
}

describe('LogViewer', () => {
  beforeEach(() => {
    MockWebSocket.instances = [];
    vi.stubGlobal('WebSocket', MockWebSocket);
    Element.prototype.scrollIntoView = vi.fn();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('does not reconnect the previous service after switching tabs', async () => {
    vi.useFakeTimers();
    const { rerender } = render(<LogViewer service="mediamtx" label="MediaMTX" />);
    expect(MockWebSocket.instances).toHaveLength(1);
    expect(MockWebSocket.instances[0].url).toContain('/api/logs/mediamtx');

    rerender(<LogViewer service="noalbs" label="NOALBS" />);
    expect(MockWebSocket.instances).toHaveLength(2);
    expect(MockWebSocket.instances[1].url).toContain('/api/logs/noalbs');

    // Late close event from the torn-down mediamtx socket must not schedule a reconnect.
    act(() => MockWebSocket.instances[0].onclose?.());
    await act(() => vi.advanceTimersByTimeAsync(5000));

    expect(MockWebSocket.instances).toHaveLength(2);
    expect(
      MockWebSocket.instances.filter((ws) => ws.url.includes('mediamtx')),
    ).toHaveLength(1);
  });

  it('clears logs when the service changes', async () => {
    const { rerender } = render(<LogViewer service="mediamtx" label="MediaMTX" />);
    const first = MockWebSocket.instances[0];
    act(() => first.onopen?.());
    act(() => first.onmessage?.({ data: 'mediamtx line' }));

    expect(screen.getByText('mediamtx line')).toBeInTheDocument();

    rerender(<LogViewer service="noalbs" label="NOALBS" />);
    expect(screen.queryByText('mediamtx line')).not.toBeInTheDocument();
  });
});
