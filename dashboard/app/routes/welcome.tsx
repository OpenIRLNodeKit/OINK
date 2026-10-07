// SPDX-FileCopyrightText: 2026 OpenIRLNodeKit contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
import { useEffect } from 'react';
import WelcomeForm from '../components/islands/WelcomeForm';
import { fetchAuthStatus } from '../lib/auth';
import { getSettings } from '../lib/api';

export default function Welcome() {
  // Full-screen setup, outside the app shell. Guard: signed in, not a viewer,
  // and not already completed — otherwise back to the dashboard.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const status = await fetchAuthStatus().catch(() => null);
      if (cancelled) return;
      if (status?.enabled && !status.ok) {
        window.location.replace('/');
        return;
      }
      if (status?.enabled && status.user?.role === 'viewer') {
        window.location.replace('/dashboard');
        return;
      }
      const settings = await getSettings().catch(() => null);
      if (cancelled) return;
      if (settings?.welcomeComplete) window.location.replace('/dashboard');
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  return <WelcomeForm />;
}
