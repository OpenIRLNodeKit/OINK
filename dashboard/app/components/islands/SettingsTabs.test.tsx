// SPDX-FileCopyrightText: 2026 OpenIRLNodeKit contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthProvider } from '../../lib/auth-context';
import SettingsTabs from './SettingsTabs';

vi.mock('../../lib/auth', async () => {
  const actual = await vi.importActual<typeof import('../../lib/auth')>('../../lib/auth');
  return {
    ...actual,
    changePassword: vi.fn(),
    listUsers: vi.fn(),
  };
});

import { listUsers, type AuthUser } from '../../lib/auth';

function stubAuthStatus(body: unknown) {
  vi.spyOn(global, 'fetch').mockImplementation(async () => {
    // Fresh Response per call: bodies are single-use streams, and the Settings
    // panels (preview, stream settings, switcher) also fetch on mount.
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  });
}

const USERS: AuthUser[] = [
  {
    id: 'u1',
    username: 'admin',
    role: 'admin',
    disabled: false,
    mustChangePassword: false,
    createdAt: '2026-01-01T00:00:00.000Z',
  },
];

describe('SettingsTabs', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('shows the General cards without a tab bar when auth is disabled', async () => {
    stubAuthStatus({ ok: false, enabled: false, user: null });
    render(
      <AuthProvider>
        <SettingsTabs />
      </AuthProvider>,
      { wrapper: MemoryRouter },
    );
    await screen.findByRole('heading', { name: 'Appearance' });
    expect(screen.queryByRole('tab')).toBeNull();
    expect(screen.getByRole('link', { name: 'Open Advanced' })).toBeInTheDocument();
  });

  it('defaults to General and lets a viewer switch to Account (no Users & Access)', async () => {
    stubAuthStatus({
      ok: true,
      enabled: true,
      user: { id: 'u2', username: 'viewer1', role: 'viewer' },
    });
    const user = userEvent.setup();
    render(
      <AuthProvider>
        <SettingsTabs />
      </AuthProvider>,
      { wrapper: MemoryRouter },
    );

    const generalTab = await screen.findByRole('tab', { name: 'General' });
    const accountTab = screen.getByRole('tab', { name: 'Account' });
    expect(generalTab).toHaveAttribute('aria-selected', 'true');
    expect(screen.queryByRole('tab', { name: 'Users & Access' })).toBeNull();
    await screen.findByRole('heading', { name: 'Appearance' });

    await user.click(accountTab);
    expect(accountTab).toHaveAttribute('aria-selected', 'true');
    await screen.findByRole('heading', { name: 'Change Password' });
  });

  it('gives an admin all three tabs and switches to Users & Access', async () => {
    stubAuthStatus({
      ok: true,
      enabled: true,
      user: { id: 'u1', username: 'admin', role: 'admin' },
    });
    vi.mocked(listUsers).mockResolvedValue({ ok: true, users: USERS });
    const user = userEvent.setup();
    render(
      <AuthProvider>
        <SettingsTabs />
      </AuthProvider>,
      { wrapper: MemoryRouter },
    );

    const generalTab = await screen.findByRole('tab', { name: 'General' });
    const accountTab = screen.getByRole('tab', { name: 'Account' });
    const usersTab = screen.getByRole('tab', { name: 'Users & Access' });
    expect(generalTab).toHaveAttribute('aria-selected', 'true');
    await screen.findByRole('heading', { name: 'Appearance' });

    await user.click(accountTab);
    await screen.findByRole('heading', { name: 'Change Password' });

    await user.click(usersTab);
    expect(usersTab).toHaveAttribute('aria-selected', 'true');
    await screen.findByRole('heading', { name: 'Users & Access' });
    await waitFor(() => expect(listUsers).toHaveBeenCalled());
    expect(await screen.findByText('admin')).toBeInTheDocument();
  });
});
