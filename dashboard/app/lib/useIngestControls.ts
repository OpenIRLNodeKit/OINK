// SPDX-FileCopyrightText: 2026 OpenIRLNodeKit contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  getIngestControls,
  type IngestControlState,
  restartIngest,
  setIngestMute,
  setIngestVisible,
} from './api';
import { useIntervalPolling } from './useIntervalPolling';

// Per-feed OBS control state (mute + scene-item visibility) for the dashboard
// Ingests card. Polled so external changes (chat, OBS itself) stay in sync, with
// an optimistic flip on toggle and a revert if the OBS call fails.
const POLL_INTERVAL_MS = 5000;

interface UseIngestControlsResult {
  state: Record<string, IngestControlState>;
  pending: string | null;
  error: string | null;
  toggleMute: (name: string) => Promise<void>;
  toggleVisibility: (name: string) => Promise<void>;
  restart: (name: string) => Promise<void>;
}

export function useIngestControls(names: string[]): UseIngestControlsResult {
  const [state, setState] = useState<Record<string, IngestControlState>>({});
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const namesRef = useRef(names);
  const stateRef = useRef(state);
  useEffect(() => {
    namesRef.current = names;
    stateRef.current = state;
  });

  const refresh = useCallback(async () => {
    const wanted = namesRef.current;
    if (wanted.length === 0) {
      setState({});
      return;
    }
    try {
      const sources = await getIngestControls(wanted);
      setState(Object.fromEntries(sources.map((s) => [s.name, s])));
      setError(null);
    } catch (e) {
      setError(
        e instanceof Error ? e.message : 'Failed to load ingest controls',
      );
    }
  }, []);

  useIntervalPolling(refresh, POLL_INTERVAL_MS);

  const flip = useCallback(
    async (
      name: string,
      field: 'muted' | 'visible',
      apply: (name: string, next: boolean) => Promise<void>,
    ) => {
      const current = stateRef.current[name]?.[field];
      if (typeof current !== 'boolean') return;
      const next = !current;
      setPending(`${name}:${field}`);
      setError(null);
      setState((prev) => ({
        ...prev,
        [name]: { ...prev[name], [field]: next },
      }));
      try {
        await apply(name, next);
      } catch (e) {
        setState((prev) => ({
          ...prev,
          [name]: { ...prev[name], [field]: current },
        }));
        setError(
          e instanceof Error
            ? e.message
            : `Failed to update ${field} for "${name}"`,
        );
      } finally {
        setPending(null);
      }
    },
    [],
  );

  const toggleMute = useCallback(
    (name: string) => flip(name, 'muted', setIngestMute),
    [flip],
  );
  const toggleVisibility = useCallback(
    (name: string) => flip(name, 'visible', setIngestVisible),
    [flip],
  );

  // "Fix" — restart the feed's OBS media input. No optimistic state (nothing
  // flips), just a pending guard + error surface.
  const restart = useCallback(async (name: string) => {
    if (stateRef.current[name]?.restartable !== true) return;
    setPending(`${name}:restart`);
    setError(null);
    try {
      await restartIngest(name);
    } catch (e) {
      setError(e instanceof Error ? e.message : `Failed to restart "${name}"`);
    } finally {
      setPending(null);
    }
  }, []);

  return { state, pending, error, toggleMute, toggleVisibility, restart };
}
