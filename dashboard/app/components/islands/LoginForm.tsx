"use client";
// SPDX-FileCopyrightText: 2026 OpenIRLNodeKit contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { type SyntheticEvent, useState } from 'react';
import { Button, Field, Input } from '../ui';

type LoginResult = { kind: 'redirect'; redirectTo?: string } | { kind: 'error'; message: string };

interface LoginFormProps {
  onSubmit?: (username: string, password: string) => Promise<LoginResult>;
  redirectTo?: string;
}

export default function LoginForm({
  onSubmit,
  redirectTo = '/dashboard',
}: LoginFormProps) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const handleSubmit = async (event: SyntheticEvent) => {
    event.preventDefault();
    setError(null);
    if (!username.trim()) {
      setError('Username is required');
      return;
    }
    if (!password) {
      setError('Password is required');
      return;
    }

    setSubmitting(true);
    try {
      const result = onSubmit
        ? await onSubmit(username.trim(), password)
        : { kind: 'redirect' as const };
      if (result.kind === 'redirect') {
        window.location.href = result.redirectTo ?? redirectTo;
      } else {
        setError(result.message);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Sign in failed');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <form className="space-y-4" onSubmit={handleSubmit} noValidate>
      <Field label="Username" htmlFor="username">
        <Input
          id="username"
          type="text"
          name="username"
          autoComplete="username"
          placeholder="admin"
          value={username}
          onChange={(e) => setUsername(e.target.value)}
          aria-invalid={error ? 'true' : undefined}
          required
          autoCapitalize="none"
          autoCorrect="off"
          autoFocus
        />
      </Field>

      <Field label="Password" htmlFor="password">
        <Input
          id="password"
          type="password"
          name="password"
          autoComplete="current-password"
          placeholder="••••••••"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          aria-invalid={error ? 'true' : undefined}
          required
        />
      </Field>

      {error && (
        <p className="text-sm text-danger" role="alert">
          {error}
        </p>
      )}

      <Button type="submit" className="w-full" disabled={submitting}>
        {submitting ? 'Signing in…' : 'Sign In'}
      </Button>
    </form>
  );
}
