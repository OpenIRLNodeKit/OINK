// SPDX-FileCopyrightText: 2026 OpenIRLNodeKit contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
import { act, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as api from '../../lib/api';
import DiskWarningBanner from './DiskWarningBanner';

vi.mock('../../lib/api', () => ({
  getDiskUsage: vi.fn(),
}));

const mockedUsage = vi.mocked(api.getDiskUsage);

function row(percent: number) {
  return {
    label: 'Assets · Recordings',
    paths: ['/home/obsuser/dependencies'],
    total: 100,
    used: percent,
    free: 100 - percent,
    percent,
  };
}

function renderBanner() {
  return render(
    <MemoryRouter>
      <DiskWarningBanner />
    </MemoryRouter>,
  );
}

describe('DiskWarningBanner', () => {
  beforeEach(() => {
    mockedUsage.mockReset();
  });

  it('stays hidden below 80%', async () => {
    mockedUsage.mockResolvedValue([row(79)]);
    renderBanner();
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('warns at 80% and links to Settings', async () => {
    mockedUsage.mockResolvedValue([row(80)]);
    renderBanner();
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Low disk space');
    expect(alert).toHaveTextContent('80% used');
    expect(screen.getByRole('link', { name: 'View disk usage' })).toHaveAttribute(
      'href',
      '/settings',
    );
    expect(screen.queryByRole('button')).toBeNull(); // persistent, not dismissible
  });

  it('uses danger styling at 90%', async () => {
    mockedUsage.mockResolvedValue([row(90)]);
    const { container } = renderBanner();
    const alert = await screen.findByRole('alert');
    expect(alert).toBeInTheDocument();
    expect(container.innerHTML).toContain('bg-danger-soft');
  });
});
