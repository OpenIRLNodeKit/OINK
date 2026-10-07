// SPDX-FileCopyrightText: 2026 OpenIRLNodeKit contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as api from '../../lib/api';
import VersionsPanel from './VersionsPanel';

vi.mock('../../lib/api', () => ({
  getVersions: vi.fn(),
  logsDownloadUrl: () => '/api/log-bundle',
}));

vi.mock('../../lib/auth-context', () => ({
  useHasRole: vi.fn(),
}));

import { useHasRole } from '../../lib/auth-context';

const mockedGetVersions = vi.mocked(api.getVersions);
const mockedHasRole = vi.mocked(useHasRole);

const VERSIONS = {
  oink: '26.09.1',
  obs: '32.1.1',
  obsWebSocket: '5.5.6',
  mediamtx: '1.20.1',
  noalbs: '2.19.2',
  plugins: [
    { name: 'obs-irl-source', version: '2.0.0', installed: true, loaded: true },
    { name: 'aitum-multistream', version: '1.0.8', installed: true, loaded: false },
  ],
  node: 'v22.12.0',
  os: 'Linux 6.8.0',
  arch: 'x64',
};

describe('VersionsPanel', () => {
  beforeEach(() => {
    mockedGetVersions.mockReset();
    mockedGetVersions.mockResolvedValue(VERSIONS as api.VersionsInfo);
    mockedHasRole.mockReset();
    mockedHasRole.mockReturnValue(true);
  });

  it('renders every component version', async () => {
    render(<VersionsPanel />);

    expect(await screen.findByText('OINK')).toBeInTheDocument();
    expect(screen.getByText('26.09.1')).toBeInTheDocument();
    expect(screen.getByText('OBS Studio')).toBeInTheDocument();
    expect(screen.getByText('32.1.1')).toBeInTheDocument();
    expect(screen.getByText('MediaMTX')).toBeInTheDocument();
    expect(screen.getByText('NOALBS')).toBeInTheDocument();
    expect(screen.getByText('obs-irl-source')).toBeInTheDocument();
    expect(screen.getByText('2.0.0')).toBeInTheDocument();
  });

  it('falls back to "unknown" for missing versions', async () => {
    mockedGetVersions.mockResolvedValue({
      ...(VERSIONS as api.VersionsInfo),
      obs: null,
      noalbs: null,
    });
    render(<VersionsPanel />);

    await screen.findByText('OINK');
    expect(screen.getAllByText('unknown').length).toBeGreaterThanOrEqual(2);
  });

  it('copies a paste-ready text block', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText },
      configurable: true,
    });
    render(<VersionsPanel />);

    await screen.findByText('OINK');
    await userEvent.click(screen.getByRole('button', { name: 'Copy' }));

    await waitFor(() => expect(writeText).toHaveBeenCalledTimes(1));
    const text = writeText.mock.calls[0][0] as string;
    expect(text).toContain('OINK: 26.09.1');
    expect(text).toContain('OBS Studio: 32.1.1');
    expect(text).toContain('obs-irl-source: 2.0.0');
  });

  it('offers the log-bundle download to operators', async () => {
    render(<VersionsPanel />);
    await screen.findByText('OINK');

    const link = screen.getByRole('link', { name: /Download all logs/ });
    expect(link).toHaveAttribute('href', '/api/log-bundle');
  });

  it('hides the log-bundle download from viewers', async () => {
    mockedHasRole.mockReturnValue(false);
    render(<VersionsPanel />);
    await screen.findByText('OINK');

    expect(
      screen.queryByRole('link', { name: /Download all logs/ }),
    ).not.toBeInTheDocument();
  });
});
