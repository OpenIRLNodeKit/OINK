"use client";
// SPDX-FileCopyrightText: 2026 OpenIRLNodeKit contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useState } from 'react';
import { changePassword, logout } from '../../lib/auth';
import { Button, Card, Field, Input } from '../ui';

interface ChangePasswordCardProps {
  forced?: boolean;
}

export default function ChangePasswordCard({
  forced = false,
}: ChangePasswordCardProps) {
  const [oldPassword, setOldPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    setMessage(null);
    if (newPassword.length < 8) {
      setMessage({ ok: false, text: 'New password must be at least 8 characters' });
      return;
    }
    if (newPassword !== confirm) {
      setMessage({ ok: false, text: 'Passwords do not match' });
      return;
    }
    setSubmitting(true);
    const result = await changePassword(oldPassword, newPassword);
    setSubmitting(false);
    if (result.ok) {
      // A password change revokes every session server-side, including this one.
      // Clear the cookie, signal other same-origin tabs (e.g. /remote), re-prompt.
      setMessage({ ok: true, text: 'Password updated. Sign in with your new password.' });
      await logout();
      window.location.replace('/');
    } else {
      setMessage({ ok: false, text: result.error ?? 'Password change failed' });
    }
  }

  return (
    <Card
      title={forced ? 'Set a new password' : 'Change Password'}
      description={
        forced
          ? 'The initial password was generated for you. Choose a password you will remember — you cannot continue until you do.'
          : 'Rotate the password for your own account.'
      }
    >
      <form className="space-y-3" onSubmit={handleSubmit} noValidate>
        <Field label="Current password" htmlFor="old-password">
          <Input
            id="old-password"
            type="password"
            autoComplete="current-password"
            value={oldPassword}
            onChange={(e) => setOldPassword(e.target.value)}
            required
          />
        </Field>
        <Field label="New password" htmlFor="new-password">
          <Input
            id="new-password"
            type="password"
            autoComplete="new-password"
            value={newPassword}
            onChange={(e) => setNewPassword(e.target.value)}
            placeholder="At least 8 characters"
            required
          />
        </Field>
        <Field label="Confirm new password" htmlFor="confirm-password">
          <Input
            id="confirm-password"
            type="password"
            autoComplete="new-password"
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
            required
          />
        </Field>
        {message && (
          <p
            className={`text-sm ${message.ok ? 'text-success' : 'text-danger'}`}
            role={message.ok ? 'status' : 'alert'}
          >
            {message.text}
          </p>
        )}
        <Button type="submit" disabled={submitting}>
          {submitting ? 'Updating…' : 'Update password'}
        </Button>
      </form>
    </Card>
  );
}
