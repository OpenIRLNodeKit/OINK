// SPDX-FileCopyrightText: 2026 OpenIRLNodeKit contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
import { useEffect, useState } from 'react';
import BrandIcon from '../components/BrandIcon';
import { Button, Field, Input } from '../components/ui';
import { completeSetup, fetchAuthStatus } from '../lib/auth';

function readSetupToken(): string {
  const hash = new URLSearchParams(window.location.hash.slice(1));
  const query = new URLSearchParams(window.location.search);
  return hash.get('token') ?? query.get('token') ?? '';
}

export default function Setup() {
  const [token] = useState(readSetupToken);
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void fetchAuthStatus()
      .then((status) => {
        if (cancelled) return;
        // Already set up: send the visitor to sign-in or the app.
        if (status.enabled && !status.setupRequired) {
          window.location.replace(status.ok ? '/dashboard' : '/');
          return;
        }
        setReady(true);
      })
      .catch(() => setReady(true));
    return () => {
      cancelled = true;
    };
  }, []);

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    setMessage(null);
    if (!username.trim()) {
      setMessage({ ok: false, text: 'Username is required' });
      return;
    }
    if (password.length < 8) {
      setMessage({ ok: false, text: 'Password must be at least 8 characters' });
      return;
    }
    if (password !== confirm) {
      setMessage({ ok: false, text: 'Passwords do not match' });
      return;
    }
    setSubmitting(true);
    const result = await completeSetup(token, username.trim(), password);
    setSubmitting(false);
    if (result.ok) {
      window.location.replace('/welcome');
      return;
    }
    setMessage({ ok: false, text: result.error ?? 'Setup failed' });
  }

  return (
    <div className="glow-hero flex min-h-screen items-center justify-center px-4 py-12">
      <div className="w-full max-w-sm">
        <div className="surface p-8">
          <div className="mb-6 text-center">
            <BrandIcon variant="logo" className="mx-auto h-9 w-auto" />
            <h1 className="mt-4 text-lg font-semibold tracking-tight">
              Set up your dashboard
            </h1>
            <p className="mt-1 text-sm text-text-secondary">
              Create the admin account you will use to sign in.
            </p>
          </div>

          {!token ? (
            <p className="text-sm text-text-secondary" role="alert">
              Open the one-time setup link printed at the end of installation.
            </p>
          ) : (
            <form className="space-y-4" onSubmit={handleSubmit} noValidate>
              <Field label="Username" htmlFor="setup-username">
                <Input
                  id="setup-username"
                  type="text"
                  autoComplete="username"
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                  required
                  autoCapitalize="none"
                  autoCorrect="off"
                />
              </Field>
              <Field label="Password" htmlFor="setup-password">
                <Input
                  id="setup-password"
                  type="password"
                  autoComplete="new-password"
                  placeholder="At least 8 characters"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  required
                  autoFocus
                />
              </Field>
              <Field label="Confirm password" htmlFor="setup-confirm">
                <Input
                  id="setup-confirm"
                  type="password"
                  autoComplete="new-password"
                  value={confirm}
                  onChange={(e) => setConfirm(e.target.value)}
                  required
                />
              </Field>
              {message && (
                <p className="text-sm text-danger" role="alert">
                  {message.text}
                </p>
              )}
              <Button type="submit" className="w-full" disabled={submitting || !ready}>
                {submitting ? 'Setting up…' : 'Set password'}
              </Button>
            </form>
          )}

          <p className="mt-6 text-center text-xs text-text-faint">
            Self-hosted Remote OBS.
          </p>
        </div>
      </div>
    </div>
  );
}
