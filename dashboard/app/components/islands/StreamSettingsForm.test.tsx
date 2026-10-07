// SPDX-FileCopyrightText: 2026 OpenIRLNodeKit contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { IngestInfo } from '../../lib/types';
import StreamSettingsForm from './StreamSettingsForm';

const mocks = vi.hoisted(() => ({
  save: vi.fn(),
  setChannel: vi.fn(),
  channel: '',
  settings: {
    encoder: 'x264' as const,
    outputWidth: 1920,
    outputHeight: 1080,
    fpsNumerator: 60,
    fpsDenominator: 1,
    bitrate: 6000,
    hasNvenc: false,
    streamActive: false,
  },
  getIngestInfo: vi.fn(),
  rotateIngestInfo: vi.fn(),
}));

vi.mock('../../lib/useObsStreamSettings', () => ({
  useObsStreamSettings: () => ({
    settings: mocks.settings,
    lastUpdated: new Date(),
    loading: false,
    error: null,
    saving: false,
    saveError: null,
    refresh: vi.fn(),
    save: mocks.save,
  }),
  formatResolution: (
    s: {
      outputHeight: number;
      fpsNumerator: number;
      fpsDenominator: number;
    } | null,
  ) =>
    s
      ? `${s.outputHeight}p${Math.round(s.fpsNumerator / s.fpsDenominator)}`
      : null,
}));

vi.mock('../../lib/api', () => ({
  getIngestInfo: mocks.getIngestInfo,
  rotateIngestInfo: mocks.rotateIngestInfo,
}));

vi.mock('../../lib/useChannel', async () => {
  const { useState } = await import('react');
  return {
    useChannel: () => {
      const [channel, setChannel] = useState('');
      return {
        channel,
        setChannel: (value: string) => {
          mocks.setChannel(value);
          setChannel(value);
        },
        loading: false,
        error: null,
      };
    },
  };
});

const INFO: IngestInfo = {
  key: 'SecretKey_123456789012345',
  defaultPath: 'live/SecretKey_123456789012345/stream',
  createdAt: 1700000000000,
  updatedAt: 1700000000000,
};

describe('StreamSettingsForm', () => {
  beforeEach(() => {
    mocks.save.mockReset();
    mocks.getIngestInfo.mockReset();
    mocks.rotateIngestInfo.mockReset();
    mocks.settings.encoder = 'x264';
    mocks.settings.outputWidth = 1920;
    mocks.settings.outputHeight = 1080;
    mocks.settings.fpsNumerator = 60;
    mocks.settings.fpsDenominator = 1;
    mocks.settings.bitrate = 6000;
    mocks.settings.hasNvenc = false;
    mocks.settings.streamActive = false;
    mocks.getIngestInfo.mockResolvedValue(INFO);
    mocks.setChannel.mockReset();
    mocks.channel = '';
  });

  it('renders resolution, framerate, and bitrate selects from current settings', () => {
    render(<StreamSettingsForm />);

    expect(screen.getByLabelText('Resolution')).toHaveValue('1920x1080');
    expect(screen.getByLabelText('Framerate')).toHaveValue('60');
    expect(screen.getByLabelText('Bitrate')).toHaveValue('6000');
    expect(screen.getByRole('button', { name: 'Apply' })).toBeDisabled();
  });

  it('shows only x264 when NVENC is unavailable', () => {
    render(<StreamSettingsForm />);
    expect(screen.queryByRole('option', { name: 'NVENC (NVIDIA)' })).toBeNull();
    expect(screen.getByLabelText('Encoder')).toHaveValue('x264');
  });

  it('renders a channel name field that saves to the server', async () => {
    const user = userEvent.setup();
    render(<StreamSettingsForm />);
    const input = screen.getByLabelText('Channel name');
    await user.type(input, 'castle_');
    expect(input).toHaveValue('castle_');
    expect(mocks.setChannel).toHaveBeenLastCalledWith('castle_');
  });

  it('shows NVENC as an option when detected', () => {
    mocks.settings.hasNvenc = true;
    render(<StreamSettingsForm />);
    expect(
      screen.getByRole('option', { name: 'NVENC (NVIDIA)' }),
    ).toBeInTheDocument();
  });

  it('snaps bitrate to the recommended value when resolution changes', async () => {
    const user = userEvent.setup();
    render(<StreamSettingsForm />);

    await user.selectOptions(screen.getByLabelText('Resolution'), '2560x1440');

    expect(screen.getByLabelText('Resolution')).toHaveValue('2560x1440');
    expect(screen.getByLabelText('Bitrate')).toHaveValue('9000');
  });

  it('applies resolution, framerate, and bitrate on Apply', async () => {
    const user = userEvent.setup();
    render(<StreamSettingsForm />);

    await user.selectOptions(screen.getByLabelText('Resolution'), '1280x720');
    await user.selectOptions(screen.getByLabelText('Framerate'), '30');
    await user.click(screen.getByRole('button', { name: 'Apply' }));

    expect(mocks.save).toHaveBeenCalledWith({
      encoder: 'x264',
      outputWidth: 1280,
      outputHeight: 720,
      fpsNumerator: 30,
      fpsDenominator: 1,
      bitrate: 4500,
    });
  });

  it('applies a custom bitrate', async () => {
    const user = userEvent.setup();
    render(<StreamSettingsForm />);

    await user.selectOptions(screen.getByLabelText('Bitrate'), 'custom');
    const custom = screen.getByLabelText('Custom bitrate (kbps)');
    await user.clear(custom);
    await user.type(custom, '5500');
    await user.click(screen.getByRole('button', { name: 'Apply' }));

    expect(mocks.save).toHaveBeenCalledWith({
      encoder: 'x264',
      outputWidth: 1920,
      outputHeight: 1080,
      fpsNumerator: 60,
      fpsDenominator: 1,
      bitrate: 5500,
    });
  });

  it('rejects a non-positive custom bitrate', async () => {
    const user = userEvent.setup();
    render(<StreamSettingsForm />);

    await user.selectOptions(screen.getByLabelText('Bitrate'), 'custom');
    const custom = screen.getByLabelText('Custom bitrate (kbps)');
    await user.clear(custom);
    await user.type(custom, '0');
    await user.click(screen.getByRole('button', { name: 'Apply' }));

    expect(mocks.save).not.toHaveBeenCalled();
    expect(
      screen.getByText(/Bitrate must be a positive whole number/),
    ).toBeInTheDocument();
  });

  it('applies the selected encoder with current values', async () => {
    mocks.settings.hasNvenc = true;
    const user = userEvent.setup();
    render(<StreamSettingsForm />);

    await user.selectOptions(screen.getByLabelText('Encoder'), 'nvenc');

    expect(mocks.save).toHaveBeenCalledWith({
      encoder: 'nvenc',
      outputWidth: 1920,
      outputHeight: 1080,
      fpsNumerator: 60,
      fpsDenominator: 1,
      bitrate: 6000,
    });
  });

  it('disables controls and shows a note while streaming', () => {
    mocks.settings.streamActive = true;
    render(<StreamSettingsForm />);

    expect(screen.getByLabelText('Resolution')).toBeDisabled();
    expect(screen.getByLabelText('Framerate')).toBeDisabled();
    expect(screen.getByLabelText('Bitrate')).toBeDisabled();
    expect(screen.getByLabelText('Encoder')).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Apply' })).toBeDisabled();
    expect(
      screen.getByText(/Stop the stream, recording, and virtual camera/),
    ).toBeInTheDocument();
  });

  describe('ingest key', () => {
    it('renders the ingest key blurred by default with View and Copy', async () => {
      const user = userEvent.setup();
      render(<StreamSettingsForm />);

      const keyInput = (await screen.findByLabelText(
        'Ingest key',
      )) as HTMLInputElement;
      expect(keyInput.value).toBe('SecretKey_123456789012345');
      expect(keyInput).toHaveAttribute('data-blurred', 'true');

      await user.click(screen.getByRole('button', { name: 'View' }));
      expect(screen.getByLabelText('Ingest key')).not.toHaveAttribute(
        'data-blurred',
        'true',
      );
      expect(screen.getByRole('button', { name: 'Hide' })).toBeInTheDocument();
    });

    it('shows an error when the ingest key cannot be loaded', async () => {
      mocks.getIngestInfo.mockRejectedValue(new Error('forbidden'));
      render(<StreamSettingsForm />);

      expect(
        await screen.findByText(/Failed to read ingest key: forbidden/),
      ).toBeInTheDocument();
    });

    it('rotates the ingest key after a confirm step', async () => {
      mocks.rotateIngestInfo.mockResolvedValue({
        ...INFO,
        key: 'NewKey_abcdefghijklmnopqr',
        defaultPath: 'live/NewKey_abcdefghijklmnopqr/stream',
        updatedAt: 1700000001000,
      });
      const user = userEvent.setup();
      render(<StreamSettingsForm />);

      await screen.findByLabelText('Ingest key');
      await user.click(
        screen.getByRole('button', { name: 'Rotate ingest key' }),
      );
      await user.click(screen.getByRole('button', { name: /Confirm rotate/ }));

      await waitFor(() =>
        expect(mocks.rotateIngestInfo).toHaveBeenCalledTimes(1),
      );
      expect(
        (screen.getByLabelText('Ingest key') as HTMLInputElement).value,
      ).toBe('NewKey_abcdefghijklmnopqr');
    });

    it('does not rotate without the confirm step', async () => {
      const user = userEvent.setup();
      render(<StreamSettingsForm />);

      await screen.findByLabelText('Ingest key');
      await user.click(
        screen.getByRole('button', { name: 'Rotate ingest key' }),
      );

      expect(mocks.rotateIngestInfo).not.toHaveBeenCalled();
    });

    it('reports a rotation failure', async () => {
      mocks.rotateIngestInfo.mockRejectedValue(new Error('restart failed'));
      const user = userEvent.setup();
      render(<StreamSettingsForm />);

      await screen.findByLabelText('Ingest key');
      await user.click(
        screen.getByRole('button', { name: 'Rotate ingest key' }),
      );
      await user.click(screen.getByRole('button', { name: /Confirm rotate/ }));

      expect(
        await screen.findByText(/Rotation failed: restart failed/),
      ).toBeInTheDocument();
    });
  });
});
