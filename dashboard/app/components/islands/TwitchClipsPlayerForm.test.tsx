// SPDX-FileCopyrightText: 2026 OpenIRLNodeKit contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import TwitchClipsPlayerForm from './TwitchClipsPlayerForm';

const mocks = vi.hoisted(() => ({
  provision: vi.fn(),
  remove: vi.fn(),
  channel: 'my_stream',
}));

vi.mock('../../lib/api', () => ({
  provisionObsBrowserSource: mocks.provision,
  deleteObsBrowserSource: mocks.remove,
}));

vi.mock('../../lib/useChannel', () => ({
  useChannel: () => ({
    channel: mocks.channel,
    setChannel: vi.fn(),
    loading: false,
    error: null,
  }),
}));

function toggleCheckbox(name: string) {
  const el = document.querySelector<HTMLInputElement>(
    `input[type="checkbox"][name="${name}"]`,
  );
  expect(el).not.toBeNull();
  el!.click();
}

describe('TwitchClipsPlayerForm', () => {
  beforeEach(() => {
    mocks.provision.mockReset().mockResolvedValue(undefined);
    mocks.remove.mockReset().mockResolvedValue(undefined);
    mocks.channel = 'my_stream';
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('renders the channel instruction and scene toggles with defaults', () => {
    render(<TwitchClipsPlayerForm />);
    expect(screen.getByText('Channel username')).toBeInTheDocument();
    expect(screen.getByText('my_stream')).toBeInTheDocument();
    expect(screen.queryByLabelText('Channel')).not.toBeInTheDocument();

    const brb = document.querySelector<HTMLInputElement>(
      'input[name="scene-brb"]',
    );
    expect(brb).not.toBeNull();
    expect(brb!.checked).toBe(true);

    const lowBr = document.querySelector<HTMLInputElement>(
      'input[name="scene-low-br"]',
    );
    expect(lowBr).not.toBeNull();
    expect(lowBr!.checked).toBe(true);

    const offline = document.querySelector<HTMLInputElement>(
      'input[name="scene-offline"]',
    );
    expect(offline).not.toBeNull();
    expect(offline!.checked).toBe(false);
  });

  it('uses the shared channel in the generated URL', () => {
    render(<TwitchClipsPlayerForm />);
    const url = screen.getByLabelText('Generated URL') as HTMLInputElement;
    expect(url.value).toContain('channel=my_stream');
  });

  it('toggles a boolean and updates the URL', () => {
    render(<TwitchClipsPlayerForm />);
    toggleCheckbox('progressBar');
    const url = screen.getByLabelText('Generated URL') as HTMLInputElement;
    expect(url.value).toContain('progressBar=true');
  });

  it('renders a link to the Twitch Clips Player website', () => {
    render(<TwitchClipsPlayerForm />);
    const link = screen.getByRole('link', { name: /Twitch Clips Player/ });
    expect(link).toHaveAttribute('href', 'https://twitchclipsplayer.com/');
    expect(link).toHaveAttribute('target', '_blank');
    expect(link).toHaveAttribute('rel', expect.stringContaining('noopener'));
  });

  it('shows "Copied!" after clicking Copy URL', async () => {
    const user = userEvent.setup();
    render(<TwitchClipsPlayerForm />);
    expect(screen.getByRole('button', { name: 'Copy URL' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Copy URL' }));
    expect(await screen.findByRole('button', { name: 'Copied!' })).toBeInTheDocument();
  });

  it('renders a Preview link that opens the generated URL in a new tab', async () => {
    render(<TwitchClipsPlayerForm />);
    const preview = screen.getByRole('link', { name: 'Preview' });
    expect(preview).toHaveAttribute(
      'href',
      expect.stringContaining('channel=my_stream'),
    );
    expect(preview).toHaveAttribute('target', '_blank');
    expect(preview).toHaveAttribute('rel', expect.stringContaining('noopener'));
  });

  it('applies the widget to the selected scenes', async () => {
    const user = userEvent.setup();
    render(<TwitchClipsPlayerForm />);
    await user.click(screen.getByRole('button', { name: /Apply to OBS/i }));
    const url = (screen.getByLabelText('Generated URL') as HTMLInputElement)
      .value;
    expect(mocks.provision).toHaveBeenCalledWith('twitch_clips', url, [
      'brb',
      'low-br',
    ]);
  });

  it('removes the widget from OBS', async () => {
    const user = userEvent.setup();
    render(<TwitchClipsPlayerForm />);
    await user.click(screen.getByRole('button', { name: 'Remove from OBS' }));
    expect(mocks.remove).toHaveBeenCalledWith('twitch_clips');
  });

  it('renders the Twitch Clips Player provider by default with its sections', () => {
    render(<TwitchClipsPlayerForm />);
    expect(
      screen.getByRole('button', { name: 'Twitch Clips Player' }),
    ).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('heading', { name: 'Clip Selection' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Appearance' })).toBeInTheDocument();
  });

  it('switches to IRLServer Player and shows its options', async () => {
    const user = userEvent.setup();
    render(<TwitchClipsPlayerForm />);
    await user.click(
      screen.getByRole('button', { name: 'IRLServer Player' }),
    );

    expect(
      screen.getByRole('button', { name: 'IRLServer Player' }),
    ).toHaveAttribute('aria-pressed', 'true');
    expect(screen.queryByRole('heading', { name: 'Clip Selection' })).not.toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Appearance' })).not.toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Clip Filters' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Playback' })).toBeInTheDocument();

    const url = screen.getByLabelText('Generated URL') as HTMLInputElement;
    expect(url.value).toContain('https://clips.irl.ac/?channelName=my_stream');
  });

  it('links to the selected provider website in IRLServer Player mode', async () => {
    const user = userEvent.setup();
    render(<TwitchClipsPlayerForm />);
    await user.click(
      screen.getByRole('button', { name: 'IRLServer Player' }),
    );
    const link = screen.getByRole('link', { name: /IRLServer Player/ });
    expect(link).toHaveAttribute('href', 'https://clips.irl.ac/');
    expect(link).toHaveAttribute('target', '_blank');
    expect(link).toHaveAttribute('rel', expect.stringContaining('noopener'));
  });

  it('updates the IRLServer URL when playback options change', async () => {
    const user = userEvent.setup();
    render(<TwitchClipsPlayerForm />);
    await user.click(
      screen.getByRole('button', { name: 'IRLServer Player' }),
    );

    const days = screen.getByLabelText('Days');
    await user.clear(days);
    await user.type(days, '7');
    const views = screen.getByLabelText('Min views');
    await user.clear(views);
    await user.type(views, '500');
    toggleCheckbox('showTimer');

    const url = screen.getByLabelText('Generated URL') as HTMLInputElement;
    expect(url.value).toContain('channelName=my_stream');
    expect(url.value).toContain('days=7');
    expect(url.value).toContain('views=500');
    expect(url.value).toContain('showTimer=true');
  });

  it('applies the IRLServer URL under the twitch_clips source name', async () => {
    const user = userEvent.setup();
    render(<TwitchClipsPlayerForm />);
    await user.click(
      screen.getByRole('button', { name: 'IRLServer Player' }),
    );

    const days = screen.getByLabelText('Days');
    await user.clear(days);
    await user.type(days, '30');

    await user.click(screen.getByRole('button', { name: /Apply to OBS/i }));
    const url = (screen.getByLabelText('Generated URL') as HTMLInputElement)
      .value;
    expect(url).toContain('https://clips.irl.ac/?channelName=my_stream');
    expect(url).toContain('days=30');
    expect(mocks.provision).toHaveBeenCalledWith('twitch_clips', url, [
      'brb',
      'low-br',
    ]);
  });

  it('persists the selected provider', async () => {
    const user = userEvent.setup();
    const { unmount } = render(<TwitchClipsPlayerForm />);
    await user.click(
      screen.getByRole('button', { name: 'IRLServer Player' }),
    );
    unmount();

    const store = window.localStorage.getItem('oink_twitch_clips_provider');
    expect(store).toBe('irlserver-player');

    render(<TwitchClipsPlayerForm />);
    expect(
      screen.getByRole('button', { name: 'IRLServer Player' }),
    ).toHaveAttribute('aria-pressed', 'true');
  });
});
