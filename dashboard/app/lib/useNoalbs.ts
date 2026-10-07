// SPDX-FileCopyrightText: 2026 OpenIRLNodeKit contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
import { useCallback, useEffect, useState } from 'react';
import { getNoalbsConfig, getServiceStatus, serviceAction } from './api';
import { useIntervalPolling } from './useIntervalPolling';

const POLL_INTERVAL_MS = 5000;

// Fallback when NOALBS has no config yet (pre-stack or unreadable): the default
// scene collection the switcher governs.
const DEFAULT_MANAGED_SCENES = ['main', 'low-br', 'offline'];

export interface NoalbsState {
  running: boolean | null;
  enabled: boolean;
  managedScenes: string[];
  active: boolean;
  pending: boolean;
  error: string | null;
  toggle: (next: boolean) => Promise<void>;
}

/**
 * Shared NOALBS state for the dashboard: the service running flag (polled so
 * out-of-band changes converge) plus the switcher config's enabled flag and the
 * three automation-managed scene names from `switcher.switchingScenes`.
 */
export function useNoalbs(): NoalbsState {
  const [running, setRunning] = useState<boolean | null>(null);
  const [enabled, setEnabled] = useState(true);
  const [managedScenes, setManagedScenes] = useState<string[]>(
    DEFAULT_MANAGED_SCENES,
  );
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refreshStatus = useCallback(async () => {
    try {
      const data = await getServiceStatus('noalbs');
      setRunning(data.running);
    } catch {
      // Service not running or API unreachable -> treat as stopped.
      setRunning(false);
    }
  }, []);

  useEffect(() => {
    void getNoalbsConfig()
      .then((cfg) => {
        setEnabled(cfg.switcher?.bitrateSwitcherEnabled ?? true);
        const scenes = cfg.switcher?.switchingScenes;
        const names = [scenes?.normal, scenes?.low, scenes?.offline].filter(
          (n): n is string => typeof n === 'string' && n.length > 0,
        );
        if (names.length > 0) setManagedScenes(names);
      })
      .catch(() => {
        // Keep defaults until NOALBS is configured.
      });
  }, []);

  useIntervalPolling(refreshStatus, POLL_INTERVAL_MS);

  const toggle = useCallback(
    async (next: boolean) => {
      setError(null);
      setPending(true);
      try {
        await serviceAction('noalbs', next ? 'start' : 'stop');
        await refreshStatus();
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Action failed');
      } finally {
        setPending(false);
      }
    },
    [refreshStatus],
  );

  return {
    running,
    enabled,
    managedScenes,
    active: running === true && enabled,
    pending,
    error,
    toggle,
  };
}
