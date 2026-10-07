// SPDX-FileCopyrightText: 2026 OpenIRLNodeKit contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as api from '../../lib/api';
import ObsPluginsCard from './ObsPluginsCard';

vi.mock('../../lib/api', () => ({
  getDefaultPluginStatus: vi.fn(),
  installDefaultPlugin: vi.fn(),
  restartObs: vi.fn(),
  uploadObsPlugin: vi.fn(),
}));

const mockedStatus = vi.mocked(api.getDefaultPluginStatus);
const mockedInstall = vi.mocked(api.installDefaultPlugin);
const mockedRestart = vi.mocked(api.restartObs);

function defaults(): api.DefaultPluginStatus[] {
  return [
    {
      name: 'obs-irl-source',
      version: '2.0.0',
      installed: true,
      loaded: true,
      dir: '/plugins/obs-irl-source',
      kind: 'tar',
      default: true,
    },
    {
      name: 'aitum-multistream',
      version: '1.0.8',
      installed: true,
      loaded: true,
      dir: '/plugins/aitum-multistream',
      kind: 'deb',
      default: true,
    },
    {
      name: 'vertical-canvas',
      version: '1.6.4',
      installed: true,
      loaded: true,
      dir: '/plugins/vertical-canvas',
      kind: 'deb',
      default: true,
    },
  ];
}

describe('ObsPluginsCard', () => {
  beforeEach(() => {
    mockedStatus.mockReset();
    mockedInstall.mockReset();
    mockedRestart.mockReset();
  });

  it('lists all default plugins as non-removable', async () => {
    mockedStatus.mockResolvedValue(defaults());
    render(<ObsPluginsCard />);

    expect(await screen.findByText('obs-irl-source 2.0.0')).toBeInTheDocument();
    expect(screen.getByText('aitum-multistream 1.0.8')).toBeInTheDocument();
    expect(screen.getByText('vertical-canvas 1.6.4')).toBeInTheDocument();
    expect(screen.getAllByText('default')).toHaveLength(3);
    expect(screen.getAllByText('installed')).toHaveLength(3);
    // Defaults are part of the build — no Remove action anywhere.
    expect(
      screen.queryByRole('button', { name: 'Remove' }),
    ).not.toBeInTheDocument();
  });

  it('offers Install only for a missing plugin, then prompts and restarts OBS', async () => {
    const plugins = defaults();
    plugins[1] = { ...plugins[1], installed: false, loaded: false };
    mockedStatus
      .mockResolvedValueOnce(plugins)
      .mockResolvedValue(defaults());
    mockedInstall.mockResolvedValue({
      ok: true,
      name: 'aitum-multistream',
      so: '/so',
      dir: '/plugins/aitum-multistream',
      restartRequired: true,
    });
    mockedRestart.mockResolvedValue(undefined);
    const user = userEvent.setup();
    render(<ObsPluginsCard />);

    const installButtons = await screen.findAllByRole('button', { name: 'Install' });
    expect(installButtons).toHaveLength(1);

    await user.click(installButtons[0]);
    expect(mockedInstall).toHaveBeenCalledWith('aitum-multistream');
    expect(
      await screen.findByText(/Restart OBS to load\/unload/),
    ).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Restart OBS now' }));
    await waitFor(() => expect(mockedRestart).toHaveBeenCalledTimes(1));
    expect(await screen.findByText('OBS restarted')).toBeInTheDocument();
  });

  it('shows loaded in OBS for every installed+loaded plugin', async () => {
    mockedStatus.mockResolvedValue(defaults());
    render(<ObsPluginsCard />);

    expect((await screen.findAllByText('loaded in OBS')).length).toBe(3);
  });

  it('shows a restart hint for Aitum plugins when installed but not loaded', async () => {
    const plugins = defaults();
    plugins[1] = { ...plugins[1], loaded: false };
    plugins[2] = { ...plugins[2], loaded: false };
    mockedStatus.mockResolvedValue(plugins);
    render(<ObsPluginsCard />);

    const hints = await screen.findAllByText('installed — restart OBS to apply');
    expect(hints).toHaveLength(2);
  });

  it('shows an error when an install fails', async () => {
    const plugins = defaults();
    plugins[0] = { ...plugins[0], installed: false, loaded: false };
    mockedStatus.mockResolvedValue(plugins);
    mockedInstall.mockRejectedValue(new Error('Checksum mismatch'));
    const user = userEvent.setup();
    render(<ObsPluginsCard />);

    await user.click(await screen.findByRole('button', { name: 'Install' }));

    expect(await screen.findByText('Checksum mismatch')).toBeInTheDocument();
  });
});
