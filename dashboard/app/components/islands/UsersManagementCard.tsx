"use client";
// SPDX-FileCopyrightText: 2026 OpenIRLNodeKit contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useEffect, useState } from 'react';
import {
  createUser,
  listUsers,
  resetUserPassword,
  setUserDisabled,
  type AuthUser,
  type Role,
} from '../../lib/auth';
import { Button, Card, Field, Input, Select } from '../ui';

const ROLES: { value: Role; label: string }[] = [
  { value: 'admin', label: 'Admin' },
  { value: 'operator', label: 'Operator' },
  { value: 'viewer', label: 'Viewer' },
];

export default function UsersManagementCard() {
  const [users, setUsers] = useState<AuthUser[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [username, setUsername] = useState('');
  const [role, setRole] = useState<Role>('viewer');
  const [password, setPassword] = useState('');
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);

  const [resettingUser, setResettingUser] = useState<string | null>(null);
  const [resetPassword, setResetPassword] = useState('');
  const [resetting, setResetting] = useState(false);

  async function refresh() {
    const result = await listUsers();
    if (result.ok && result.users) {
      setUsers(result.users);
      setError(null);
    } else {
      setError(result.error ?? 'Failed to load users');
    }
    setLoading(false);
  }

  useEffect(() => {
    void refresh();
  }, []);

  async function handleCreate(event: React.FormEvent) {
    event.preventDefault();
    setCreateError(null);
    if (!username.trim()) {
      setCreateError('Username is required');
      return;
    }
    if (password.length < 8) {
      setCreateError('Password must be at least 8 characters');
      return;
    }
    setCreating(true);
    const result = await createUser(username.trim(), role, password);
    setCreating(false);
    if (!result.ok) {
      setCreateError(result.error ?? 'Failed to create user');
      return;
    }
    setUsername('');
    setPassword('');
    setRole('viewer');
    void refresh();
  }

  async function handleReset(usernameToReset: string) {
    if (resetPassword.length < 8) {
      setCreateError('Password must be at least 8 characters');
      return;
    }
    setResetting(true);
    const result = await resetUserPassword(usernameToReset, resetPassword);
    setResetting(false);
    if (!result.ok) {
      setCreateError(result.error ?? 'Failed to reset password');
      return;
    }
    setCreateError(null);
    setResettingUser(null);
    setResetPassword('');
    void refresh();
  }

  async function toggleDisabled(user: AuthUser) {
    const result = await setUserDisabled(user.username, !user.disabled);
    if (!result.ok) {
      setError(result.error ?? 'Failed to update user');
      return;
    }
    setError(null);
    void refresh();
  }

  return (
    <Card
      title="Users & Access"
      description="Manage dashboard accounts and roles. Password hashes stay on this box."
    >
      <div className="space-y-5">
        {error && (
          <p className="text-sm text-danger" role="alert">
            {error}
          </p>
        )}

        {loading ? (
          <p className="text-sm text-text-secondary">Loading users…</p>
        ) : (
          <ul className="divide-y divide-border-subtle">
            {users.map((user) => (
              <li key={user.id} className="py-3">
                <div className="flex items-center justify-between gap-3">
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium text-text-primary">
                      {user.username}
                      {user.disabled && (
                        <span className="ml-2 text-xs font-medium text-text-faint">
                          (disabled)
                        </span>
                      )}
                    </p>
                    <p className="text-xs text-text-secondary">
                      {user.role}
                      {user.id && (user.username === 'admin' ? ' · built-in' : '')}
                    </p>
                  </div>
                  <div className="flex shrink-0 items-center gap-2">
                    {user.disabled ? (
                      <button
                        type="button"
                        onClick={() => toggleDisabled(user)}
                        className="rounded-control bg-bg-elevated px-2.5 py-1 text-xs font-medium text-text-primary ring-1 ring-inset ring-border-subtle transition-colors hover:ring-border"
                      >
                        Enable
                      </button>
                    ) : (
                      <button
                        type="button"
                        onClick={() => toggleDisabled(user)}
                        className="rounded-control bg-bg-elevated px-2.5 py-1 text-xs font-medium text-text-secondary ring-1 ring-inset ring-border-subtle transition-colors hover:bg-danger-soft hover:text-danger"
                      >
                        Disable
                      </button>
                    )}
                    <button
                      type="button"
                      onClick={() => {
                        setResettingUser(resettingUser === user.username ? null : user.username);
                        setResetPassword('');
                        setCreateError(null);
                      }}
                      className="rounded-control bg-bg-elevated px-2.5 py-1 text-xs font-medium text-text-primary ring-1 ring-inset ring-border-subtle transition-colors hover:ring-border"
                    >
                      {resettingUser === user.username ? 'Cancel' : 'Reset password'}
                    </button>
                  </div>
                </div>
                {resettingUser === user.username && (
                  <form
                    className="mt-3 flex flex-col gap-2 sm:flex-row"
                    onSubmit={(event) => {
                      event.preventDefault();
                      void handleReset(user.username);
                    }}
                  >
                    <Input
                      type="password"
                      value={resetPassword}
                      onChange={(e) => setResetPassword(e.target.value)}
                      placeholder="New password (8+ chars)"
                      aria-label={`New password for ${user.username}`}
                      className="sm:max-w-xs"
                      required
                    />
                    <Button type="submit" disabled={resetting || resetPassword.length < 8}>
                      {resetting ? 'Saving…' : 'Confirm reset'}
                    </Button>
                  </form>
                )}
              </li>
            ))}
          </ul>
        )}

        <form onSubmit={handleCreate} className="space-y-3 border-t border-border-subtle pt-4">
          {createError && (
            <p className="text-sm text-danger" role="alert">
              {createError}
            </p>
          )}
          <div className="grid gap-3 sm:grid-cols-[1fr_auto]">
            <Field label="Username" htmlFor="new-user-username">
              <Input
                id="new-user-username"
                type="text"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                placeholder="e.g. camera-operator"
                autoCapitalize="none"
                autoCorrect="off"
                required
              />
            </Field>
            <Field label="Role" htmlFor="new-user-role">
              <Select
                id="new-user-role"
                value={role}
                onChange={(e) => setRole(e.target.value as Role)}
              >
                {ROLES.map((r) => (
                  <option key={r.value} value={r.value}>
                    {r.label}
                  </option>
                ))}
              </Select>
            </Field>
          </div>
          <Field
            label="Password"
            htmlFor="new-user-password"
            hint="At least 8 characters. Passwords are stored as salted scrypt hashes."
          >
            <Input
              id="new-user-password"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="••••••••"
              required
            />
          </Field>
          <Button type="submit" disabled={creating}>
            {creating ? 'Creating…' : 'Add user'}
          </Button>
        </form>
      </div>
    </Card>
  );
}
