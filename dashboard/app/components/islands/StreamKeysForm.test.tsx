// SPDX-FileCopyrightText: 2026 OpenIRLNodeKit contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as api from '../../lib/api';
import StreamKeysForm from './StreamKeysForm';

vi.mock('../../lib/api', () => ({
  getPrimaryPlatform: vi.fn(),
  setPrimaryPlatform: vi.fn(),
  getObsStreamService: vi.fn(),
  setObsStreamServiceKey: vi.fn(),
  getMultistreamKeys: vi.fn(),
  saveMultistreamKeys: vi.fn(),
  restartObs: vi.fn(),
}));

const mockedGetPrimary = vi.mocked(api.getPrimaryPlatform);
const mockedSetPrimary = vi.mocked(api.setPrimaryPlatform);
const mockedGetStreamService = vi.mocked(api.getObsStreamService);
const mockedSetStreamServiceKey = vi.mocked(api.setObsStreamServiceKey);
const mockedGetMultistream = vi.mocked(api.getMultistreamKeys);
const mockedSaveMultistream = vi.mocked(api.saveMultistreamKeys);
const mockedRestart = vi.mocked(api.restartObs);

describe('StreamKeysForm', () => {
  beforeEach(() => {
    mockedGetPrimary.mockReset();
    mockedSetPrimary.mockReset();
    mockedGetStreamService.mockReset();
    mockedSetStreamServiceKey.mockReset();
    mockedGetMultistream.mockReset();
    mockedSaveMultistream.mockReset();
    mockedRestart.mockReset();

    // Mock window.confirm to return true by default
    vi.spyOn(window, 'confirm').mockReturnValue(true);

    mockedGetPrimary.mockResolvedValue('twitch');
    mockedGetStreamService.mockResolvedValue({
      platform: 'twitch',
      service: 'Twitch',
      server: 'rtmp://live.twitch.tv/app',
      key: '',
      keyLast4: null,
    });
    mockedGetMultistream.mockResolvedValue({
      platforms: {
        kick: { configured: false, last4: null },
        youtube: { configured: false, last4: null },
      },
      primaryPlatform: 'twitch',
    });
  });

  it('shows all three platforms as selectable options', async () => {
    render(<StreamKeysForm />);

    const twitchButtons = await screen.findAllByRole('button', { name: /Twitch/ });
    const youtubeButtons = await screen.findAllByRole('button', { name: /YouTube/ });
    const kickButtons = await screen.findAllByRole('button', { name: /Kick/ });

    expect(twitchButtons.length).toBeGreaterThan(0);
    expect(youtubeButtons.length).toBeGreaterThan(0);
    expect(kickButtons.length).toBeGreaterThan(0);
  });

  it('marks the primary platform with "Primary (Built-in)" label', async () => {
    render(<StreamKeysForm />);

    expect(await screen.findByText('Primary (Built-in)')).toBeInTheDocument();
    expect(screen.getAllByText('Multistream')).toHaveLength(2);
  });

  it('shows stream key inputs for primary and multistream platforms', async () => {
    render(<StreamKeysForm />);

    await screen.findByLabelText('Twitch stream key');
    await screen.findByLabelText('Kick');
    await screen.findByLabelText('YouTube');
  });

  it('shows masked key status when keys are configured', async () => {
    mockedGetStreamService.mockResolvedValue({
      platform: 'twitch',
      service: 'Twitch',
      server: 'rtmp://live.twitch.tv/app',
      key: '',
      keyLast4: '1234',
    });
    mockedGetMultistream.mockResolvedValue({
      platforms: {
        kick: { configured: true, last4: '5678' },
        youtube: { configured: false, last4: null },
      },
      primaryPlatform: 'twitch',
    });

    render(<StreamKeysForm />);

    expect(await screen.findByText(/Currently set \(••••1234\)/)).toBeInTheDocument();
    expect(await screen.findByText(/Currently set \(••••5678\)/)).toBeInTheDocument();
  });

  it('saves primary key when entered', async () => {
    mockedSetStreamServiceKey.mockResolvedValue({
      platform: 'twitch',
      service: 'Twitch',
      server: 'rtmp://live.twitch.tv/app',
      key: '',
      keyLast4: 'abcd',
    });

    const user = userEvent.setup();
    render(<StreamKeysForm />);

    const primaryInput = await screen.findByLabelText('Twitch stream key');
    await user.type(primaryInput, 'twitch_key_1234');
    await user.click(screen.getByRole('button', { name: 'Save all keys' }));

    await waitFor(() =>
      expect(mockedSetStreamServiceKey).toHaveBeenCalledWith('twitch_key_1234'),
    );
  });

  it('saves multistream keys when entered', async () => {
    mockedSaveMultistream.mockResolvedValue({
      platforms: {
        kick: { configured: true, last4: 'abcd' },
        youtube: { configured: false, last4: null },
      },
      primaryPlatform: 'twitch',
    });

    const user = userEvent.setup();
    render(<StreamKeysForm />);

    const kickInput = await screen.findByLabelText('Kick');
    await user.type(kickInput, 'kick_key_5678');
    await user.click(screen.getByRole('button', { name: 'Save all keys' }));

    await waitFor(() =>
      expect(mockedSaveMultistream).toHaveBeenCalledWith({ kick: 'kick_key_5678' }),
    );
  });

  it('saves both primary and multistream keys in one action', async () => {
    mockedSetStreamServiceKey.mockResolvedValue({
      platform: 'twitch',
      service: 'Twitch',
      server: 'rtmp://live.twitch.tv/app',
      key: '',
      keyLast4: 'abcd',
    });
    mockedSaveMultistream.mockResolvedValue({
      platforms: {
        kick: { configured: true, last4: '5678' },
        youtube: { configured: true, last4: '1234' },
      },
      primaryPlatform: 'twitch',
    });

    const user = userEvent.setup();
    render(<StreamKeysForm />);

    await user.type(await screen.findByLabelText('Twitch stream key'), 'twitch_key');
    await user.type(await screen.findByLabelText('Kick'), 'kick_key');
    await user.type(await screen.findByLabelText('YouTube'), 'youtube_key');
    await user.click(screen.getByRole('button', { name: 'Save all keys' }));

    await waitFor(() => {
      expect(mockedSetStreamServiceKey).toHaveBeenCalledWith('twitch_key');
      expect(mockedSaveMultistream).toHaveBeenCalledWith({
        kick: 'kick_key',
        youtube: 'youtube_key',
      });
    });
  });

  it('shows restart prompt after saving only the primary key', async () => {
    mockedSetStreamServiceKey.mockResolvedValue({
      platform: 'twitch',
      service: 'Twitch',
      server: 'rtmp://live.twitch.tv/app',
      key: '',
      keyLast4: 'abcd',
    });

    const user = userEvent.setup();
    render(<StreamKeysForm />);

    await user.type(await screen.findByLabelText('Twitch stream key'), 'twitch_key');
    await user.click(screen.getByRole('button', { name: 'Save all keys' }));

    expect(
      await screen.findByText(/Primary stream key saved — restart OBS to apply/),
    ).toBeInTheDocument();
    expect(screen.getByText('Restart OBS to apply the changes?')).toBeInTheDocument();
  });

  it('does not prompt to restart after saving multistream keys', async () => {
    mockedSaveMultistream.mockResolvedValue({
      platforms: {
        kick: { configured: true, last4: '5678' },
        youtube: { configured: false, last4: null },
      },
      primaryPlatform: 'twitch',
    });

    const user = userEvent.setup();
    render(<StreamKeysForm />);

    await user.type(await screen.findByLabelText('Kick'), 'kick_key_5678');
    await user.click(screen.getByRole('button', { name: 'Save all keys' }));

    expect(
      await screen.findByText(/Stream keys saved — OBS restarted automatically/),
    ).toBeInTheDocument();
    expect(screen.queryByText('Restart OBS to apply the changes?')).not.toBeInTheDocument();
  });

  it('changes primary platform when clicked', async () => {
    mockedSetPrimary.mockResolvedValue({ restartRequired: true });

    const user = userEvent.setup();
    render(<StreamKeysForm />);

    await screen.findByLabelText('Twitch stream key');
    const youtubeButton = screen.getAllByRole('button', { name: /YouTube/ })[0];
    await user.click(youtubeButton);

    await waitFor(() => expect(mockedSetPrimary).toHaveBeenCalledWith('youtube'));
  });

  it('reveals and hides keys with per-input toggles', async () => {
    const user = userEvent.setup();
    render(<StreamKeysForm />);

    const primaryInput = await screen.findByLabelText('Twitch stream key');
    expect(primaryInput).toHaveAttribute('type', 'password');

    await user.click(screen.getByRole('button', { name: 'Show Twitch key' }));
    expect(primaryInput).toHaveAttribute('type', 'text');

    await user.click(screen.getByRole('button', { name: 'Hide Twitch key' }));
    expect(primaryInput).toHaveAttribute('type', 'password');
  });

  it('disables save button when no keys are entered', async () => {
    render(<StreamKeysForm />);

    const saveButton = await screen.findByRole('button', { name: 'Save all keys' });
    expect(saveButton).toBeDisabled();
  });
});
