// SPDX-FileCopyrightText: 2026 OpenIRLNodeKit contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
import { useEffect } from "react";
import LoginForm from "../components/islands/LoginForm";
import BrandIcon from "../components/BrandIcon";
import { fetchAuthStatus, login } from "../lib/auth";
import { getSettings } from "../lib/api";

// Where a signed-in user lands: forced rotation first, then the first-run
// welcome if it hasn't been completed, else the dashboard.
async function postLoginTarget(mustChangePassword: boolean): Promise<string> {
  if (mustChangePassword) return '/change-password';
  const settings = await getSettings().catch(() => null);
  return settings && !settings.welcomeComplete ? '/welcome' : '/dashboard';
}

export default function Index() {
  // Already signed in? Skip the form and go straight to the app.
  useEffect(() => {
    let cancelled = false;
    void fetchAuthStatus()
      .then(async (status) => {
        if (cancelled) return;
        if (status.setupRequired) {
          window.location.replace('/setup');
          return;
        }
        if (!status.enabled || !status.ok) return;
        const target = await postLoginTarget(Boolean(status.user?.mustChangePassword));
        if (!cancelled) window.location.replace(target);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <div className="glow-hero flex min-h-screen items-center justify-center px-4 py-12">
      <div className="w-full max-w-sm">
        <div className="surface p-8">
          <div className="mb-6 text-center">
            <BrandIcon variant="logo" className="mx-auto h-9 w-auto" />
            <h1 className="mt-4 text-lg font-semibold tracking-tight">OINK Control Room</h1>
            <p className="mt-1 text-sm text-text-secondary">Sign in to your dashboard</p>
          </div>

          <LoginForm
            onSubmit={async (username, password) => {
              const result = await login(username, password);
              if (result.ok) {
                const mustChange = Boolean(
                  result.user && result.user.mustChangePassword,
                );
                return {
                  kind: 'redirect' as const,
                  redirectTo: await postLoginTarget(mustChange),
                };
              }
              return { kind: 'error', message: result.error ?? 'Sign in failed' };
            }}
          />

          <p className="mt-6 text-center text-xs text-text-faint">
            Self-hosted Remote OBS.
          </p>
        </div>
      </div>
    </div>
  );
}
