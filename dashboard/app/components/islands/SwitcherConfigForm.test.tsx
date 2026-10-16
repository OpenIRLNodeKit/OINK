// SPDX-FileCopyrightText: 2026 OpenIRLNodeKit contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { NoalbsConfig } from '../../lib/types';
import SwitcherConfigForm from './SwitcherConfigForm';

const mocks = vi.hoisted(() => ({
  getNoalbsConfig: vi.fn(),
  getNoalbsEnv: vi.fn(),
  saveNoalbsConfig: vi.fn(),
  saveNoalbsEnv: vi.fn(),
}));

vi.mock('../../lib/api', () => ({
  getNoalbsConfig: mocks.getNoalbsConfig,
  getNoalbsEnv: mocks.getNoalbsEnv,
  saveNoalbsConfig: mocks.saveNoalbsConfig,
  saveNoalbsEnv: mocks.saveNoalbsEnv,
}));

const CONFIG: NoalbsConfig = {
  switcher: {
    bitrateSwitcherEnabled: true,
    triggers: { low: 900, offline: 300 },
  },
  chat: {
    admins: ['mod1', 'mod2'],
    commands: {
      Fix: { permission: 'Mod', userPermissions: ['old'], alias: ['f'] },
      Switch: { permission: 'Mod', alias: ['ss'] },
    },
  },
};

const ENV = [
  '# NOALBS bot creds',
  'TWITCH_BOT_USERNAME=my_bot',
  'TWITCH_BOT_OAUTH=<redacted>',
  '',
].join('\n');

describe('SwitcherConfigForm', () => {
  beforeEach(() => {
    mocks.getNoalbsConfig.mockReset();
    mocks.getNoalbsEnv.mockReset();
    mocks.saveNoalbsConfig.mockReset();
    mocks.saveNoalbsEnv.mockReset();
    mocks.getNoalbsConfig.mockResolvedValue(CONFIG);
    mocks.getNoalbsEnv.mockResolvedValue(ENV);
    mocks.saveNoalbsConfig.mockResolvedValue(undefined);
    mocks.saveNoalbsEnv.mockResolvedValue(undefined);
  });

  it('loads the bot username and admins, and never prefills the oauth', async () => {
    render(<SwitcherConfigForm />);

    expect(await screen.findByLabelText('Bot username')).toHaveValue('my_bot');
    expect(screen.getByLabelText('Mods / Admins')).toHaveValue('mod1, mod2');
    expect(screen.getByLabelText('Bot OAuth token')).toHaveValue('');
    expect(screen.getByText(/Currently set/)).toBeInTheDocument();
  });

  it('treats a missing .env as empty', async () => {
    mocks.getNoalbsEnv.mockRejectedValue(new Error('404'));
    render(<SwitcherConfigForm />);

    expect(await screen.findByLabelText('Bot username')).toHaveValue('');
    expect(screen.getByLabelText('Bot OAuth token')).toHaveValue('');
  });

  it('saves username + admins and preserves the redacted oauth', async () => {
    const user = userEvent.setup();
    render(<SwitcherConfigForm />);

    const username = await screen.findByLabelText('Bot username');
    await user.clear(username);
    await user.type(username, 'new_bot');
    await user.type(screen.getByLabelText('Mods / Admins'), ', mod3');
    await user.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(mocks.saveNoalbsEnv).toHaveBeenCalledTimes(1));
    const env = mocks.saveNoalbsEnv.mock.calls[0][0] as string;
    expect(env).toContain('TWITCH_BOT_USERNAME=new_bot');
    expect(env).toContain('TWITCH_BOT_OAUTH=<redacted>');
    expect(env).toContain('# NOALBS bot creds');

    const cfg = mocks.saveNoalbsConfig.mock.calls[0][0] as NoalbsConfig;
    expect(cfg.chat?.admins).toEqual(['mod1', 'mod2', 'mod3']);
    // Only the admins array changes; per-command config is left untouched.
    expect(cfg.chat?.commands).toEqual(CONFIG.chat?.commands);
  });

  it('replaces the oauth when a new token is typed', async () => {
    const user = userEvent.setup();
    render(<SwitcherConfigForm />);

    const oauth = await screen.findByLabelText('Bot OAuth token');
    await user.type(oauth, 'oauth:newtoken');
    await user.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(mocks.saveNoalbsEnv).toHaveBeenCalledTimes(1));
    const env = mocks.saveNoalbsEnv.mock.calls[0][0] as string;
    expect(env).toContain('TWITCH_BOT_OAUTH=oauth:newtoken');
  });
});
