// SPDX-FileCopyrightText: 2026 OpenIRLNodeKit contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { IngestControlState } from '../../lib/api';
import type { IngestSeries } from '../../lib/useStatusUpdate';
import IngestMenu from './IngestMenu';

function feed(id: string, bitrate: number, ready = true): IngestSeries {
  return { id, ready, bitrate, history: [] };
}

const control = (
  over: Partial<IngestControlState> = {},
): IngestControlState => ({
  name: 'test',
  muted: false,
  visible: true,
  restartable: true,
  ...over,
});

function renderMenu(
  props: Partial<React.ComponentProps<typeof IngestMenu>> = {},
) {
  return render(
    <IngestMenu
      ingests={[feed('stream', 0, false), feed('test', 4200)]}
      selected={null}
      onSelect={() => {}}
      connected
      controls={{}}
      pending={null}
      onToggleMute={() => {}}
      onToggleVisibility={() => {}}
      onRestart={() => {}}
      {...props}
    />,
  );
}

describe('IngestMenu', () => {
  it('renders an empty state while connecting', () => {
    renderMenu({ ingests: [], connected: false });
    expect(screen.getByText('Connecting to status feed…')).toBeInTheDocument();
  });

  it('lists feeds, counts active ones, and reports the selection', () => {
    const onSelect = vi.fn();
    renderMenu({ selected: 'test', onSelect });
    expect(screen.getByText('1 active')).toBeInTheDocument();
    expect(screen.getByText('4200 kbps')).toBeInTheDocument();
    expect(screen.getByText('offline')).toBeInTheDocument();

    const streamRow = screen.getAllByTestId('ingest-row')[1];
    fireEvent.click(within(streamRow).getAllByRole('button')[0]);
    expect(onSelect).toHaveBeenCalledWith('stream');
  });

  it('puts active feeds first', () => {
    renderMenu();
    const rows = screen.getAllByTestId('ingest-row');
    expect(rows[0]).toHaveTextContent('test');
    expect(rows[1]).toHaveTextContent('stream');
  });

  it('reflects mute + visibility state and fires the handlers', () => {
    const onToggleMute = vi.fn();
    const onToggleVisibility = vi.fn();
    renderMenu({
      controls: { test: control({ muted: false, visible: true }) },
      onToggleMute,
      onToggleVisibility,
    });

    fireEvent.click(screen.getByRole('button', { name: 'Mute test' }));
    expect(onToggleMute).toHaveBeenCalledWith('test');

    fireEvent.click(screen.getByRole('button', { name: 'Hide test' }));
    expect(onToggleVisibility).toHaveBeenCalledWith('test');
  });

  it('offers a Fix button only for restartable sources and fires it', () => {
    const onRestart = vi.fn();
    const { rerender } = renderMenu({
      controls: { test: control({ restartable: true }) },
      onRestart,
    });
    fireEvent.click(screen.getByRole('button', { name: 'Fix test' }));
    expect(onRestart).toHaveBeenCalledWith('test');

    rerender(
      <IngestMenu
        ingests={[feed('test', 4200)]}
        selected={null}
        onSelect={() => {}}
        connected
        controls={{ test: control({ restartable: false }) }}
        pending={null}
        onToggleMute={() => {}}
        onToggleVisibility={() => {}}
        onRestart={() => {}}
      />,
    );
    expect(screen.getByRole('button', { name: 'Fix test' })).toBeDisabled();
  });

  it('shows the muted/hidden state and disables controls with no OBS source', () => {
    const { rerender } = renderMenu({
      controls: { test: control({ muted: true, visible: false }) },
    });
    expect(screen.getByRole('button', { name: 'Unmute test' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    expect(screen.getByRole('button', { name: 'Show test' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );

    rerender(
      <IngestMenu
        ingests={[feed('test', 4200)]}
        selected={null}
        onSelect={() => {}}
        connected
        controls={{}}
        pending={null}
        onToggleMute={() => {}}
        onToggleVisibility={() => {}}
        onRestart={() => {}}
      />,
    );
    expect(screen.getByRole('button', { name: 'Mute test' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Hide test' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Fix test' })).toBeDisabled();
  });

  it('flashes the Fix button after it is pressed', () => {
    vi.useFakeTimers();
    try {
      const onRestart = vi.fn();
      renderMenu({
        controls: { test: control({ restartable: true }) },
        onRestart,
      });
      const fix = screen.getByRole('button', { name: 'Fix test' });
      expect(fix).not.toHaveClass('bg-warning');

      fireEvent.click(fix);
      expect(onRestart).toHaveBeenCalledWith('test');
      expect(fix).toHaveClass('bg-warning');

      act(() => vi.advanceTimersByTime(1000));
      expect(fix).not.toHaveClass('bg-warning');
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps the Monitored badge legible on a selected row', () => {
    const { rerender } = renderMenu({ selected: 'test', monitored: 'test' });
    expect(screen.getByText('Monitored')).toHaveClass(
      'text-on-primary',
      'bg-white/20',
    );

    rerender(
      <IngestMenu
        ingests={[feed('test', 4200)]}
        selected={null}
        monitored="test"
        onSelect={() => {}}
        connected
        controls={{}}
        pending={null}
        onToggleMute={() => {}}
        onToggleVisibility={() => {}}
        onRestart={() => {}}
      />,
    );
    expect(screen.getByText('Monitored')).toHaveClass('text-primary');
  });
});
