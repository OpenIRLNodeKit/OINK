// SPDX-FileCopyrightText: 2026 OpenIRLNodeKit contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthProvider } from '../../lib/auth-context';
import AccountProfileCard from './AccountProfileCard';

vi.mock('../../lib/auth', async () => {
  const actual = await vi.importActual<typeof import('../../lib/auth')>('../../lib/auth');
  return {
    ...actual,
    uploadAvatar: vi.fn(),
    removeAvatar: vi.fn(),
  };
});

import { removeAvatar, uploadAvatar } from '../../lib/auth';

const USER = {
  id: 'u1',
  username: 'admin',
  role: 'admin' as const,
  disabled: false,
  mustChangePassword: false,
  createdAt: '2026-01-01T00:00:00.000Z',
  avatarUrl: null as string | null,
};

function stubAuthStatus(body: unknown) {
  vi.spyOn(global, 'fetch').mockImplementation(async () => {
    // Fresh Response per call: status is refetched after every mutation, and a
    // shared Response would have a single-use body stream.
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  });
}

function renderCard() {
  render(
    <AuthProvider>
      <AccountProfileCard />
    </AuthProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('AccountProfileCard', () => {
  it('shows the profile picture card with initials until an avatar is set', async () => {
    stubAuthStatus({ ok: true, enabled: true, user: USER });
    renderCard();
    await screen.findByRole('heading', { name: 'Profile Picture' });
    expect(screen.getByText('A?')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Upload picture' })).toBeDisabled();
  });

  it('rejects a non-image selection before uploading', async () => {
    stubAuthStatus({ ok: true, enabled: true, user: USER });
    renderCard();
    await screen.findByRole('heading', { name: 'Profile Picture' });

    const input = screen.getByLabelText('Choose profile picture');
    fireEvent.change(input, {
      target: { files: [new File(['x'], 'note.txt', { type: 'text/plain' })] },
    });

    expect(await screen.findByRole('status')).toHaveTextContent(
      'Picture must be a PNG, JPEG, WebP, or GIF image',
    );
    expect(screen.getByRole('button', { name: 'Upload picture' })).toBeDisabled();
  });

  it('uploads a valid image and refreshes the auth status', async () => {
    stubAuthStatus({ ok: true, enabled: true, user: USER });
    vi.mocked(uploadAvatar).mockResolvedValue({
      ok: true,
      user: { ...USER, avatarUrl: '/api/auth/avatar?v=1' },
    });
    const user = userEvent.setup();
    renderCard();
    await screen.findByRole('heading', { name: 'Profile Picture' });

    const input = screen.getByLabelText('Choose profile picture');
    const file = new File(['png'], 'me.png', { type: 'image/png' });
    fireEvent.change(input, { target: { files: [file] } });

    const upload = screen.getByRole('button', { name: 'Upload picture' });
    expect(upload).toBeEnabled();
    await user.click(upload);

    await waitFor(() => expect(uploadAvatar).toHaveBeenCalledWith(file));
    expect(await screen.findByRole('status')).toHaveTextContent('Profile picture updated.');
  });

  it('removes the avatar when one is set', async () => {
    stubAuthStatus({
      ok: true,
      enabled: true,
      user: { ...USER, avatarUrl: '/api/auth/avatar?v=1' },
    });
    vi.mocked(removeAvatar).mockResolvedValue({ ok: true, user: { ...USER, avatarUrl: null } });
    const user = userEvent.setup();
    renderCard();
    await screen.findByRole('heading', { name: 'Profile Picture' });

    await user.click(screen.getByRole('button', { name: 'Remove' }));
    await waitFor(() => expect(removeAvatar).toHaveBeenCalled());
    expect(await screen.findByRole('status')).toHaveTextContent('Profile picture removed.');
  });
});
