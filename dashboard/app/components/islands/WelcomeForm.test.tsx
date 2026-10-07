// SPDX-FileCopyrightText: 2026 OpenIRLNodeKit contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import WelcomeForm from './WelcomeForm';
import {
  getMultistreamKeys,
  getObsStreamService,
  getSettings,
  saveSettings,
} from '../../lib/api';

vi.mock('../../lib/api', () => ({
  getSettings: vi.fn(),
  saveSettings: vi.fn(),
  getObsStreamService: vi.fn(),
  getMultistreamKeys: vi.fn(),
}));

vi.mock('../../lib/useObsStreamSettings', () => ({
  useObsStreamSettings: () => ({
    settings: null,
    lastUpdated: null,
    loading: false,
    error: null,
    saving: false,
    saveError: null,
    refresh: vi.fn(),
    save: vi.fn(),
  }),
  formatResolution: () => null,
}));

vi.mock('./StreamKeysForm', () => ({
  default: () => <div data-testid="stream-keys" />,
}));

function stubLocation() {
  const original = window.location;
  const replace = vi.fn();
  Object.defineProperty(window, 'location', {
    configurable: true,
    value: { ...original, replace },
  });
  return () => Object.defineProperty(window, 'location', { configurable: true, value: original });
}

describe('WelcomeForm', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getSettings).mockResolvedValue({
      welcomeComplete: false,
      twitchChannel: '',
      presetProvided: false,
    });
    vi.mocked(getObsStreamService).mockResolvedValue({
      platform: 'twitch', service: 'Twitch', server: '', key: '', keyLast4: null,
    });
    vi.mocked(getMultistreamKeys).mockResolvedValue({
      platforms: {}, primaryPlatform: 'twitch',
    });
    vi.mocked(saveSettings).mockResolvedValue({
      welcomeComplete: true,
      twitchChannel: '',
      presetProvided: false,
    });
  });

  afterEach(() => vi.restoreAllMocks());

  it('shows every section when nothing is configured', async () => {
    const restore = stubLocation();
    try {
      render(<WelcomeForm />);
      expect(await screen.findByLabelText('Twitch channel name')).toBeInTheDocument();
      expect(screen.getByTestId('stream-keys')).toBeInTheDocument();
      expect(screen.getByLabelText('Resolution')).toBeInTheDocument();
    } finally {
      restore();
    }
  });

  it('hides sections that the env already provided', async () => {
    vi.mocked(getSettings).mockResolvedValue({
      welcomeComplete: false,
      twitchChannel: 'castle_',
      presetProvided: true,
    });
    vi.mocked(getObsStreamService).mockResolvedValue({
      platform: 'twitch', service: 'Twitch', server: '', key: 'sk', keyLast4: '1234',
    });
    const restore = stubLocation();
    try {
      render(<WelcomeForm />);
      expect(await screen.findByText('Everything is already configured.')).toBeInTheDocument();
      expect(screen.queryByLabelText('Twitch channel name')).not.toBeInTheDocument();
      expect(screen.queryByTestId('stream-keys')).not.toBeInTheDocument();
    } finally {
      restore();
    }
  });

  it('finishing marks the welcome complete and lands on the dashboard', async () => {
    const user = userEvent.setup();
    const restore = stubLocation();
    try {
      render(<WelcomeForm />);
      await screen.findByLabelText('Twitch channel name');
      await user.type(screen.getByLabelText('Twitch channel name'), 'castle_');
      await user.click(screen.getByRole('button', { name: 'Finish setup' }));
      await waitFor(() =>
        expect(saveSettings).toHaveBeenCalledWith({
          welcomeComplete: true,
          twitchChannel: 'castle_',
        }),
      );
      await waitFor(() => expect(window.location.replace).toHaveBeenCalledWith('/dashboard'));
    } finally {
      restore();
    }
  });

  it('skipping marks the welcome complete without forcing fields', async () => {
    const user = userEvent.setup();
    const restore = stubLocation();
    try {
      render(<WelcomeForm />);
      await screen.findByLabelText('Twitch channel name');
      await user.click(screen.getByRole('button', { name: 'Skip for now' }));
      await waitFor(() =>
        expect(saveSettings).toHaveBeenCalledWith({ welcomeComplete: true }),
      );
    } finally {
      restore();
    }
  });
});
