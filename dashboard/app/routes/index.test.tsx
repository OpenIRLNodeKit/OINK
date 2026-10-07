// SPDX-FileCopyrightText: 2026 OpenIRLNodeKit contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
import { render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Index from './index';
import { fetchAuthStatus } from '../lib/auth';
import { getSettings } from '../lib/api';

vi.mock('../lib/auth', () => ({
  fetchAuthStatus: vi.fn(),
  login: vi.fn(),
}));

vi.mock('../lib/api', () => ({
  getSettings: vi.fn(),
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

const AUTHED = {
  ok: true,
  enabled: true,
  user: { id: 'u1', username: 'admin', role: 'admin' as const, disabled: false, createdAt: '' },
};

describe('index (root login page)', () => {
  beforeEach(() => {
    vi.mocked(getSettings).mockResolvedValue({
      welcomeComplete: true,
      twitchChannel: '',
      presetProvided: false,
    });
  });

  afterEach(() => vi.restoreAllMocks());

  it('sends an already signed-in user to the dashboard', async () => {
    const restore = stubLocation();
    vi.mocked(fetchAuthStatus).mockResolvedValue(AUTHED);
    try {
      render(<Index />);
      await vi.waitFor(() => expect(window.location.replace).toHaveBeenCalledWith('/dashboard'));
    } finally {
      restore();
    }
  });

  it('sends a signed-in user to the welcome when it is incomplete', async () => {
    const restore = stubLocation();
    vi.mocked(fetchAuthStatus).mockResolvedValue(AUTHED);
    vi.mocked(getSettings).mockResolvedValue({
      welcomeComplete: false,
      twitchChannel: '',
      presetProvided: false,
    });
    try {
      render(<Index />);
      await vi.waitFor(() => expect(window.location.replace).toHaveBeenCalledWith('/welcome'));
    } finally {
      restore();
    }
  });

  it('sends a must-change user to the change-password screen', async () => {
    const restore = stubLocation();
    vi.mocked(fetchAuthStatus).mockResolvedValue({
      ...AUTHED,
      user: { ...AUTHED.user, mustChangePassword: true },
    });
    try {
      render(<Index />);
      await vi.waitFor(() =>
        expect(window.location.replace).toHaveBeenCalledWith('/change-password'),
      );
    } finally {
      restore();
    }
  });

  it('keeps an unauthenticated visitor on the form', async () => {
    const restore = stubLocation();
    vi.mocked(fetchAuthStatus).mockResolvedValue({ ok: false, enabled: true, user: null });
    try {
      render(<Index />);
      await vi.waitFor(() => expect(fetchAuthStatus).toHaveBeenCalled());
      expect(window.location.replace).not.toHaveBeenCalled();
    } finally {
      restore();
    }
  });
});
