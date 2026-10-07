// SPDX-FileCopyrightText: 2026 OpenIRLNodeKit contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
import { useEffect, useState } from 'react';
import ChangePasswordCard from '../components/islands/ChangePasswordCard';
import BrandIcon from '../components/BrandIcon';
import { fetchAuthStatus } from '../lib/auth';

export default function ChangePassword() {
  const [username, setUsername] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void fetchAuthStatus().then((s) => {
      if (!cancelled && s.user?.username) setUsername(s.user.username);
    });
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
            <h1 className="mt-4 text-lg font-semibold tracking-tight">
              {username ? `Welcome, ${username}` : 'Welcome'}
            </h1>
            <p className="mt-1 text-sm text-text-secondary">
              Set a password you will remember before you continue.
            </p>
          </div>

          <ChangePasswordCard forced />
        </div>
      </div>
    </div>
  );
}
