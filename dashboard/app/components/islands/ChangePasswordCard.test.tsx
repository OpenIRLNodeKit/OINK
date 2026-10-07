// SPDX-FileCopyrightText: 2026 OpenIRLNodeKit contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import ChangePasswordCard from './ChangePasswordCard';

vi.mock('../../lib/auth', () => ({
  changePassword: vi.fn(),
  logout: vi.fn(),
}));

import { changePassword, logout } from '../../lib/auth';

const replaceMock = vi.fn();

beforeEach(() => {
  vi.clearAllMocks();
  replaceMock.mockClear();
  Object.defineProperty(window, 'location', {
    configurable: true,
    value: { replace: replaceMock },
  });
});

describe('ChangePasswordCard (forced)', () => {
  it('renders the forced-rotation copy when forced', () => {
    render(<ChangePasswordCard forced />);
    expect(screen.getByText('Set a new password')).toBeInTheDocument();
    expect(
      screen.getByText(/The initial password was generated for you/),
    ).toBeInTheDocument();
  });

  it('logs out and re-prompts after a successful rotation', async () => {
    const user = userEvent.setup();
    vi.mocked(changePassword).mockResolvedValue({ ok: true });
    render(<ChangePasswordCard forced />);

    await user.type(screen.getByLabelText('Current password'), 'seed-password');
    await user.type(screen.getByLabelText('New password'), 'my-new-password');
    await user.type(screen.getByLabelText('Confirm new password'), 'my-new-password');
    await user.click(screen.getByRole('button', { name: 'Update password' }));

    await waitFor(() =>
      expect(changePassword).toHaveBeenCalledWith('seed-password', 'my-new-password'),
    );
    await waitFor(() => expect(logout).toHaveBeenCalledTimes(1));
    expect(replaceMock).toHaveBeenCalledWith('/');
  });

  it('keeps the user on the screen when the rotation fails', async () => {
    const user = userEvent.setup();
    vi.mocked(changePassword).mockResolvedValue({
      ok: false,
      error: 'Current password is incorrect',
    });
    render(<ChangePasswordCard forced />);

    await user.type(screen.getByLabelText('Current password'), 'wrong-password');
    await user.type(screen.getByLabelText('New password'), 'my-new-password');
    await user.type(screen.getByLabelText('Confirm new password'), 'my-new-password');
    await user.click(screen.getByRole('button', { name: 'Update password' }));

    expect(
      await screen.findByText('Current password is incorrect'),
    ).toBeInTheDocument();
    expect(logout).not.toHaveBeenCalled();
    expect(replaceMock).not.toHaveBeenCalled();
  });
});
