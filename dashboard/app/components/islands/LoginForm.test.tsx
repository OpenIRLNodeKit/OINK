// SPDX-FileCopyrightText: 2026 OpenIRLNodeKit contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import LoginForm from './LoginForm';

describe('LoginForm', () => {
  it('shows a validation error when the username is empty', async () => {
    const user = userEvent.setup();
    render(<LoginForm onSubmit={vi.fn()} />);

    await user.type(screen.getByLabelText('Password'), 'secret');
    await user.click(screen.getByRole('button', { name: 'Sign In' }));

    expect(
      await screen.findByText('Username is required'),
    ).toBeInTheDocument();
  });

  it('shows a validation error when the password is empty', async () => {
    const user = userEvent.setup();
    render(<LoginForm onSubmit={vi.fn()} />);

    await user.type(screen.getByLabelText('Username'), 'admin');
    await user.click(screen.getByRole('button', { name: 'Sign In' }));

    expect(
      await screen.findByText('Password is required'),
    ).toBeInTheDocument();
  });

  it('calls onSubmit with username+password and redirects on success', async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn().mockResolvedValue({ kind: 'redirect' as const });
    const originalLocation = window.location;
    const assign = vi.fn();
    Object.defineProperty(window, 'location', {
      value: { ...originalLocation, href: '' },
      writable: true,
    });

    render(<LoginForm onSubmit={onSubmit} />);
    await user.type(screen.getByLabelText('Username'), 'admin');
    await user.type(screen.getByLabelText('Password'), 'secret');
    await user.click(screen.getByRole('button', { name: 'Sign In' }));

    await waitFor(() => expect(onSubmit).toHaveBeenCalledWith('admin', 'secret'));
    await waitFor(() => expect(window.location.href).toBe('/dashboard'));
    assign.mockRestore();
  });

  it('shows an error message when sign-in fails', async () => {
    const user = userEvent.setup();
    const onSubmit = vi
      .fn()
      .mockResolvedValue({ kind: 'error', message: 'Bad credentials' });
    render(<LoginForm onSubmit={onSubmit} />);

    await user.type(screen.getByLabelText('Username'), 'admin');
    await user.type(screen.getByLabelText('Password'), 'wrong');
    await user.click(screen.getByRole('button', { name: 'Sign In' }));

    expect(await screen.findByText('Bad credentials')).toBeInTheDocument();
  });
});
