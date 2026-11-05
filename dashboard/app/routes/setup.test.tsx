// SPDX-FileCopyrightText: 2026 OpenIRLNodeKit contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Setup from './setup';
import { completeSetup, fetchAuthStatus } from '../lib/auth';

vi.mock('../lib/auth', () => ({
  completeSetup: vi.fn(),
  fetchAuthStatus: vi.fn(),
}));

function stubLocation(hash: string) {
  const original = window.location;
  const replace = vi.fn();
  Object.defineProperty(window, 'location', {
    configurable: true,
    value: { ...original, hash, search: '', replace },
  });
  return () => Object.defineProperty(window, 'location', { configurable: true, value: original });
}

const SETUP = {
  ok: false,
  enabled: true,
  user: null,
  setupRequired: true,
  setupUsername: 'admin',
};

describe('first-run setup page', () => {
  beforeEach(() => {
    vi.mocked(fetchAuthStatus).mockResolvedValue(SETUP);
    vi.mocked(completeSetup).mockResolvedValue({ ok: true, user: null });
  });

  afterEach(() => vi.restoreAllMocks());

  it('submits the token from the URL and the chosen password', async () => {
    const restore = stubLocation('#token=setup-token');
    try {
      const user = userEvent.setup();
      render(<Setup />);
      await vi.waitFor(() =>
        expect(screen.getByRole('button', { name: 'Set password' })).toBeEnabled(),
      );
      const username = screen.getByLabelText('Username');
      expect((username as HTMLInputElement).value).toBe('admin');
      await user.clear(username);
      await user.type(username, 'streamer');
      await user.type(screen.getByLabelText('Password'), 'new-password');
      await user.type(screen.getByLabelText('Confirm password'), 'new-password');
      await user.click(screen.getByRole('button', { name: 'Set password' }));
      await vi.waitFor(() =>
        expect(completeSetup).toHaveBeenCalledWith('setup-token', 'streamer', 'new-password'),
      );
      expect(window.location.replace).toHaveBeenCalledWith('/welcome');
    } finally {
      restore();
    }
  });
});
