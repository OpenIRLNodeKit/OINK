// SPDX-FileCopyrightText: 2026 OpenIRLNodeKit contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as api from '../../lib/api';
import type { IngestInfo } from '../../lib/types';
import IngestManager from './IngestManager';

vi.mock('../../lib/api', () => ({
  getIngestInfo: vi.fn(),
  getIngestProfiles: vi.fn().mockResolvedValue({ profiles: [], main: 'irl' }),
  saveIngestProfiles: vi.fn().mockImplementation(
    async (profiles: string[], main = 'irl') => ({ profiles, main }),
  ),
  getIrlSourceStatus: vi.fn().mockResolvedValue({
    name: 'obs-irl-source',
    version: '2.0.0',
    installed: true,
    loaded: true,
    dir: '/plugins/obs-irl-source',
  }),
  provisionObsMediaSource: vi.fn(),
  deleteObsMediaSource: vi.fn(),
}));

const mockedGet = vi.mocked(api.getIngestInfo);
const mockedGetProfiles = vi.mocked(api.getIngestProfiles);
const mockedSaveProfiles = vi.mocked(api.saveIngestProfiles);
const mockedProvision = vi.mocked(api.provisionObsMediaSource);
const mockedDelete = vi.mocked(api.deleteObsMediaSource);
const mockedIrlStatus = vi.mocked(api.getIrlSourceStatus);

const INFO: IngestInfo = {
  key: 'SecretKey_123456789012345',
  defaultPath: 'live/SecretKey_123456789012345/irl',
  createdAt: 1700000000000,
  updatedAt: 1700000000000,
};

function renderPage() {
  return render(<IngestManager />);
}

describe('IngestManager', () => {
  beforeEach(() => {
    mockedGet.mockReset();
    mockedGetProfiles.mockReset();
    mockedSaveProfiles.mockReset();
    mockedProvision.mockReset();
    mockedDelete.mockReset();
    mockedIrlStatus.mockReset();
    mockedGetProfiles.mockResolvedValue({ profiles: [], main: 'irl' });
    mockedSaveProfiles.mockImplementation(
      async (profiles: string[], main = 'irl') => ({ profiles, main }),
    );
    mockedIrlStatus.mockResolvedValue({
      name: 'obs-irl-source',
      version: '2.0.0',
      installed: true,
      loaded: true,
      dir: '/plugins/obs-irl-source',
    });
    localStorage.clear();
  });

  it('builds keyed URLs from the fetched stream key after saving a profile', async () => {
    mockedGet.mockResolvedValue(INFO);
    mockedProvision.mockResolvedValue(undefined);
    const user = userEvent.setup();
    renderPage();

    // Wait for the key fetch to resolve before typing a label.
    await waitFor(() => expect(mockedGet).toHaveBeenCalledTimes(1));
    await user.type(screen.getByLabelText('Stream Name'), 'irl_main');
    await user.click(screen.getByRole('button', { name: 'Save Current' }));
    const rtmp = screen.getByLabelText('RTMP URL') as HTMLInputElement;
    expect(rtmp.value).toContain('live/SecretKey_123456789012345/irl_main');
  });

  it('locks the URL cards until a profile is saved or loaded', async () => {
    mockedGet.mockResolvedValue(INFO);
    const user = userEvent.setup();
    renderPage();

    await waitFor(() => expect(mockedGet).toHaveBeenCalledTimes(1));
    const rtmp = screen.getByLabelText('RTMP URL') as HTMLInputElement;
    expect(rtmp.value).toBe('');

    await user.type(screen.getByLabelText('Stream Name'), 'irl_main');
    for (const btn of screen.getAllByRole('button', { name: 'Copy' })) {
      expect(btn).toBeDisabled();
    }
    expect(
      (screen.getByLabelText('Destination name') as HTMLInputElement).value,
    ).toBe('');
    expect(screen.getByText(/unlock these links/)).toBeInTheDocument();
  });

  it('shows LiveU Solo fields for the active profile', async () => {
    mockedGet.mockResolvedValue(INFO);
    mockedProvision.mockResolvedValue(undefined);
    const user = userEvent.setup();
    renderPage();

    await waitFor(() => expect(mockedGet).toHaveBeenCalledTimes(1));
    await user.type(screen.getByLabelText('Stream Name'), 'irl_main');
    await user.click(screen.getByRole('button', { name: 'Save Current' }));

    expect(
      (screen.getByLabelText('Destination name') as HTMLInputElement).value,
    ).toBe('irl_main');
    expect(
      (screen.getByLabelText('Primary Ingress URL') as HTMLInputElement).value,
    ).toContain(':8890');
    expect(
      (screen.getByLabelText('Stream Name / Key') as HTMLInputElement).value,
    ).toBe('publish:live/SecretKey_123456789012345/irl_main');
  });

  it('does not render a readable stream key field on the page', async () => {
    mockedGet.mockResolvedValue(INFO);
    renderPage();

    await waitFor(() => expect(mockedGet).toHaveBeenCalledTimes(1));
    // The raw key input that used to live here is gone — it now lives under
    // Settings → Stream Settings. Only the (blurred) URL cards embed the key.
    expect(screen.queryByDisplayValue('SecretKey_123456789012345')).toBeNull();
    expect(screen.queryByLabelText('Stream key')).toBeNull();
  });

  it('shows an error state when the key cannot be loaded', async () => {
    mockedGet.mockRejectedValue(new Error('forbidden'));
    renderPage();

    expect(await screen.findByText('forbidden')).toBeInTheDocument();
  });

  it('provisions OBS on save with the keyed IRL read URL', async () => {
    mockedGet.mockResolvedValue(INFO);
    mockedProvision.mockResolvedValue(undefined);
    const user = userEvent.setup();
    renderPage();

    await waitFor(() => expect(mockedGet).toHaveBeenCalledTimes(1));
    await user.type(screen.getByLabelText('Stream Name'), 'irl_main');
    await user.click(screen.getByRole('button', { name: 'Save Current' }));

    expect(mockedProvision).toHaveBeenCalledWith(
      'irl_main',
      expect.stringContaining(
        'streamid=read:live/SecretKey_123456789012345/irl_main',
      ),
    );
    expect(
      await screen.findByText(/Provisioned in OBS as IRL Source/),
    ).toBeInTheDocument();
  });

  it('disables Save when the IRL Source plugin is not loaded', async () => {
    mockedGet.mockResolvedValue(INFO);
    mockedIrlStatus.mockResolvedValue({
      name: 'obs-irl-source',
      version: '2.0.0',
      installed: false,
      loaded: false,
      dir: '/plugins/obs-irl-source',
    });
    const user = userEvent.setup();
    renderPage();

    await waitFor(() => expect(mockedIrlStatus).toHaveBeenCalled());
    await user.type(screen.getByLabelText('Stream Name'), 'irl_main');
    expect(screen.getByRole('button', { name: 'Save Current' })).toBeDisabled();
    expect(screen.getByText(/install it under Settings/)).toBeInTheDocument();
  });

  it('deletes a profile and its OBS source after confirmation', async () => {
    mockedGet.mockResolvedValue(INFO);
    mockedProvision.mockResolvedValue(undefined);
    mockedDelete.mockResolvedValue(undefined);
    const user = userEvent.setup();
    renderPage();

    await waitFor(() => expect(mockedGet).toHaveBeenCalledTimes(1));
    await user.type(screen.getByLabelText('Stream Name'), 'old_feed');
    await user.click(screen.getByRole('button', { name: 'Save Current' }));

    await user.click(await screen.findByRole('button', { name: 'Delete' }));
    await user.click(screen.getByRole('button', { name: 'Confirm?' }));

    await waitFor(() => expect(mockedDelete).toHaveBeenCalledWith('old_feed'));
    expect(screen.queryByText('old_feed')).not.toBeInTheDocument();
  });

  it('re-fetches the key on the poll interval', async () => {
    vi.useFakeTimers();
    try {
      mockedGet.mockResolvedValue(INFO);
      renderPage();
      await act(async () => {});
      expect(mockedGet).toHaveBeenCalledTimes(1);

      await act(async () => {
        await vi.advanceTimersByTimeAsync(10000);
      });
      expect(mockedGet).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });
});
