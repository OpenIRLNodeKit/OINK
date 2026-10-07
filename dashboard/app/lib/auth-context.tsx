"use client";
// SPDX-FileCopyrightText: 2026 OpenIRLNodeKit contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import {
  type ReactNode,
  createContext,
  useContext,
  useEffect,
  useState,
} from 'react';
import { fetchAuthStatus, LOGOUT_KEY, type AuthStatus } from './auth';

interface AuthContextValue extends AuthStatus {
  loading: boolean;
  refresh: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue>({
  ok: false,
  enabled: false,
  user: null,
  loading: true,
  refresh: async () => {},
});

export function AuthProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<AuthStatus>({
    ok: false,
    enabled: false,
    user: null,
  });
  const [loading, setLoading] = useState(true);

  async function refresh() {
    setStatus(await fetchAuthStatus());
    setLoading(false);
  }

  useEffect(() => {
    void refresh();
  }, []);

  // Sign out when another tab logs out (the session cookie is browser-wide, so
  // this tab is already unauthenticated — it just hasn't looked yet).
  useEffect(() => {
    function onStorage(e: StorageEvent) {
      if (e.key === LOGOUT_KEY) window.location.replace('/');
    }
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, []);

  // ponytail: 15s poll — catches server-side revocation (password change, admin
  // disable, expiry) this browser can't see; matches /remote's net.
  useEffect(() => {
    const id = setInterval(async () => {
      const status = await fetchAuthStatus();
      if (status.enabled && !status.ok) window.location.replace('/');
    }, 15000);
    return () => clearInterval(id);
  }, []);

  return (
    <AuthContext.Provider value={{ ...status, loading, refresh }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth(): AuthContextValue {
  return useContext(AuthContext);
}

export function useEffectiveRole(): string | null {
  const { user, enabled } = useAuth();
  if (!enabled) return 'admin';
  return user?.role ?? null;
}

export function useHasRole(roles: string[]): boolean {
  const role = useEffectiveRole();
  return Boolean(role && roles.includes(role));
}
