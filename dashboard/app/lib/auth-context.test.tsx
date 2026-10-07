// SPDX-FileCopyrightText: 2026 OpenIRLNodeKit contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
import { render } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { AuthProvider, useEffectiveRole, useHasRole } from './auth-context';

describe('useEffectiveRole / useHasRole', () => {
  it('treats everything as admin when auth is disabled', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({ ok: false, enabled: false, user: null }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    );

    let role: string | null = null;
    let hasAll = false;
    let hasAdmin = false;
    let hasViewer = false;
    function Probe() {
      role = useEffectiveRole();
      hasAll = useHasRole(['admin', 'operator', 'viewer']);
      hasAdmin = useHasRole(['admin']);
      hasViewer = useHasRole(['viewer']);
      return <div />;
    }

    render(
      <AuthProvider>
        <Probe />
      </AuthProvider>,
    );

    await vi.waitFor(() => {
      expect(role).toBe('admin');
      expect(hasAll).toBe(true);
      expect(hasAdmin).toBe(true);
      expect(hasViewer).toBe(false);
    });
  });

  it('restricts role checks when auth is enabled', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          ok: true,
          enabled: true,
          user: { id: 'u2', username: 'viewer1', role: 'viewer' },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    );

    let role: string | null = null;
    let hasAdmin = false;
    let hasViewer = false;
    function Probe() {
      role = useEffectiveRole();
      hasAdmin = useHasRole(['admin']);
      hasViewer = useHasRole(['viewer']);
      return <div />;
    }

    render(
      <AuthProvider>
        <Probe />
      </AuthProvider>,
    );

    await vi.waitFor(() => {
      expect(role).toBe('viewer');
      expect(hasAdmin).toBe(false);
      expect(hasViewer).toBe(true);
    });
  });

  it('redirects to / when another tab signs out', () => {
    vi.spyOn(global, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({ ok: true, enabled: true, user: { id: 'u1', username: 'admin', role: 'admin' } }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    );
    const original = window.location;
    const replace = vi.fn();
    Object.defineProperty(window, 'location', {
      configurable: true,
      value: { ...original, replace },
    });

    try {
      render(
        <AuthProvider>
          <div />
        </AuthProvider>,
      );
      window.dispatchEvent(new StorageEvent('storage', { key: 'oink_logout' }));
      expect(replace).toHaveBeenCalledWith('/');
    } finally {
      Object.defineProperty(window, 'location', { configurable: true, value: original });
    }
  });
});
