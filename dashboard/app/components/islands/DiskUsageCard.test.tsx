// SPDX-FileCopyrightText: 2026 OpenIRLNodeKit contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as api from '../../lib/api';
import DiskUsageCard from './DiskUsageCard';

vi.mock('../../lib/api', () => ({
  getDiskUsage: vi.fn(),
}));

const mockedUsage = vi.mocked(api.getDiskUsage);

describe('DiskUsageCard', () => {
  beforeEach(() => {
    mockedUsage.mockReset();
  });

  it('renders a usage bar for each filesystem', async () => {
    mockedUsage.mockResolvedValue([
      {
        label: 'Assets · Recordings',
        paths: ['/home/obsuser/dependencies'],
        total: 100,
        used: 84,
        free: 16,
        percent: 84,
      },
    ]);
    render(<DiskUsageCard />);

    expect(
      await screen.findByRole('heading', { name: 'Disk space' }),
    ).toBeInTheDocument();
    const bar = screen.getByRole('progressbar', {
      name: 'Assets · Recordings disk usage',
    });
    expect(bar).toHaveAttribute('aria-valuenow', '84');
    expect(screen.getByText('84% · 16 B free')).toBeInTheDocument();
    expect(screen.getByText('84 B used of 100 B')).toBeInTheDocument();
  });

  it('shows an error instead of stale numbers', async () => {
    mockedUsage.mockRejectedValue(new Error('disk down'));
    render(<DiskUsageCard />);
    expect(await screen.findByRole('alert')).toHaveTextContent('disk down');
  });
});
