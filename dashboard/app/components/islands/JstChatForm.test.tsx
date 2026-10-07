// SPDX-FileCopyrightText: 2026 OpenIRLNodeKit contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import JstChatForm from './JstChatForm';

const mocks = vi.hoisted(() => ({
  provision: vi.fn(),
  remove: vi.fn(),
  channel: 'castle_',
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

describe('JstChatForm', () => {
  beforeEach(() => {
    mocks.provision.mockReset().mockResolvedValue(undefined);
    mocks.remove.mockReset().mockResolvedValue(undefined);
    mocks.channel = 'castle_';
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('renders the channel instruction and scene toggles with defaults', () => {
    render(<JstChatForm />);
    expect(screen.getByText('Channel username')).toBeInTheDocument();
    expect(screen.getByText('castle_')).toBeInTheDocument();
    expect(screen.queryByLabelText('Channel')).not.toBeInTheDocument();

    const brb = document.querySelector<HTMLInputElement>(
      'input[name="scene-brb"]',
    );
    expect(brb).not.toBeNull();
    expect(brb!.checked).toBe(true);

    const offline = document.querySelector<HTMLInputElement>(
      'input[name="scene-offline"]',
    );
    expect(offline).not.toBeNull();
    expect(offline!.checked).toBe(false);
  });

  it('builds a channel URL from the shared channel', () => {
    render(<JstChatForm />);
    const url = screen.getByLabelText('Generated URL') as HTMLInputElement;
    expect(url.value).toContain('channel=castle_');
    expect(url.value).toContain('JstChat2/#/chat?');
  });

  it('renders a link to the JstChat2 website', () => {
    render(<JstChatForm />);
    const link = screen.getByRole('link', { name: /JstChat2/ });
    expect(link).toHaveAttribute(
      'href',
      'https://itsalviiin.github.io/JstChat2/#/',
    );
    expect(link).toHaveAttribute('target', '_blank');
    expect(link).toHaveAttribute('rel', expect.stringContaining('noopener'));
  });

  it('renders the chat options with default states', () => {
    render(<JstChatForm />);
    expect(screen.getByText('Chat options')).toBeInTheDocument();

    const shadow = document.querySelector<HTMLInputElement>(
      'input[name="chat-shadow"]',
    );
    expect(shadow).not.toBeNull();
    expect(shadow!.checked).toBe(true);

    const hideBots = document.querySelector<HTMLInputElement>(
      'input[name="chat-hide-bots"]',
    );
    expect(hideBots).not.toBeNull();
    expect(hideBots!.checked).toBe(true);

    const highlight = document.querySelector<HTMLInputElement>(
      'input[name="chat-highlight-first"]',
    );
    expect(highlight).not.toBeNull();
    expect(highlight!.checked).toBe(false);

    const hideCommands = document.querySelector<HTMLInputElement>(
      'input[name="chat-hide-commands"]',
    );
    expect(hideCommands).not.toBeNull();
    expect(hideCommands!.checked).toBe(false);

    const badge = screen.getByLabelText('Shared chat badge') as HTMLSelectElement;
    expect(badge.value).toBe('off');
  });

  it('toggles chat options and updates the generated URL', async () => {
    const user = userEvent.setup();
    render(<JstChatForm />);

    await user.click(
      document.querySelector('input[name="chat-highlight-first"]')!,
    );
    await user.click(
      document.querySelector('input[name="chat-hide-commands"]')!,
    );
    await user.click(
      document.querySelector('input[name="chat-shadow"]')!,
    );
    await user.click(
      document.querySelector('input[name="chat-hide-bots"]')!,
    );

    const url = screen.getByLabelText('Generated URL') as HTMLInputElement;
    expect(url.value).toContain('highlight_first_time=true');
    expect(url.value).toContain('hide_commands=true');
    expect(url.value).toContain('shadow=false');
    expect(url.value).toContain('hide_bots=false');
  });

  it('sets fade after seconds, shared badge, and ignore list in the URL', async () => {
    const user = userEvent.setup();
    render(<JstChatForm />);

    const fade = screen.getByLabelText('Fade messages');
    await user.clear(fade);
    await user.type(fade, '45');
    await user.selectOptions(
      screen.getByLabelText('Shared chat badge'),
      'profile',
    );
    await user.click(
      document.querySelector('input[name="chat-self-shared-badge"]')!,
    );
    await user.type(screen.getByLabelText('Ignore list'), 'nightbot, x');

    const url = screen.getByLabelText('Generated URL') as HTMLInputElement;
    expect(url.value).toContain('fade_after=45');
    expect(url.value).toContain('shared_chat_badge=profile');
    expect(url.value).toContain('self_shared_badge=true');
    expect(url.value).toContain('hide=nightbot,x');
  });

  it('renders a Preview link opening the generated URL in a new tab', async () => {
    render(<JstChatForm />);
    const preview = screen.getByRole('link', { name: 'Preview' });
    expect(preview).toHaveAttribute(
      'href',
      expect.stringContaining('channel=castle_'),
    );
    expect(preview).toHaveAttribute('target', '_blank');
    expect(preview).toHaveAttribute('rel', expect.stringContaining('noopener'));
  });

  it('applies the chat source (audio off) to the selected scenes', async () => {
    const user = userEvent.setup();
    render(<JstChatForm />);
    await user.click(screen.getByRole('button', { name: /Apply to OBS/i }));
    const url = (screen.getByLabelText('Generated URL') as HTMLInputElement)
      .value;
    expect(mocks.provision).toHaveBeenCalledWith('twitch_chat', url, [
      'brb',
      'low-br',
    ], false);
  });

  it('removes the chat source from OBS', async () => {
    const user = userEvent.setup();
    render(<JstChatForm />);
    await user.click(screen.getByRole('button', { name: 'Remove from OBS' }));
    expect(mocks.remove).toHaveBeenCalledWith('twitch_chat');
  });

  it('disables Apply until a channel is set in channel mode', () => {
    mocks.channel = '';
    render(<JstChatForm />);
    expect(
      screen.getByRole('button', { name: /Apply to OBS/i }),
    ).toBeDisabled();
  });
});
