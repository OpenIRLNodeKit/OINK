// SPDX-FileCopyrightText: 2026 OpenIRLNodeKit contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
import { useEffect } from 'react';
import { Outlet, useLocation } from 'react-router';
import DiskWarningBanner from '../components/islands/DiskWarningBanner';
import { Header } from '../components/Header';
import { Sidebar } from '../components/Sidebar';
import { AuthProvider } from '../lib/auth-context';
import { fetchAuthStatus as fetchAuthStatusRaw } from '../lib/auth';
import { getSettings } from '../lib/api';

const TITLES: Record<string, string> = {
  '/dashboard': 'Dashboard',
  '/preview': 'Preview',
  '/settings': 'Settings',
  '/overlays': 'Overlays',
  '/ingest': 'Ingest',
  '/assets': 'Assets',
  '/recordings': 'Recordings',
  '/advanced': 'Advanced',
};

const ACTIVE_PAGES: Record<string, string> = {
  '/dashboard': 'dashboard',
  '/preview': 'preview',
  '/settings': 'settings',
  '/overlays': 'overlays',
  '/ingest': 'ingest',
  '/assets': 'assets',
  '/recordings': 'recordings',
  '/advanced': 'advanced',
};

export default function AuthLayout() {
  const location = useLocation();
  const pathname = location.pathname.replace(/\/$/, '') || '/dashboard';
  const title = TITLES[pathname] ?? 'Dashboard';
  const activePage = ACTIVE_PAGES[pathname] ?? 'dashboard';

  // Redirect to / when the server enforces control-plane auth and this
  // browser has no valid session cookie. Auth is genuinely enforced server-side;
  // this guard is only UX (a session cookie is what unlocks the /api/* calls).
  // When auth is disabled (local dev / mocked e2e) nothing happens. Uses a
  // page-level fetch so it does not depend on the provider for the redirect.
  // Accounts awaiting their forced first-login rotation are sent to the
  // change-password screen (the server locks them out of every other route).
  useEffect(() => {
    let cancelled = false;
    void fetchAuthStatusRaw()
      .then(async (status) => {
        if (cancelled) return;
        if (status.setupRequired) {
          window.location.replace('/setup');
        } else if (status.enabled && !status.ok) {
          window.location.replace('/');
        } else if (status.enabled && status.ok && status.user?.mustChangePassword) {
          window.location.replace('/change-password');
        } else if (status.enabled && status.ok && status.user?.role !== 'viewer') {
          // A fresh install still owes the first-run welcome (operators only).
          const settings = await getSettings().catch(() => null);
          if (!cancelled && settings && !settings.welcomeComplete) {
            window.location.replace('/welcome');
          }
        }
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <AuthProvider>
      <div className="flex h-screen overflow-hidden">
        <Sidebar activePage={activePage} />
        <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
          <Header title={title} />
          <DiskWarningBanner />
          <main className="flex-1 overflow-y-auto">
            <div className="mx-auto w-full max-w-6xl px-4 py-6 sm:px-6 lg:px-8">
              <Outlet />
            </div>
          </main>
        </div>
      </div>
    </AuthProvider>
  );
}
