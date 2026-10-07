// SPDX-FileCopyrightText: 2026 OpenIRLNodeKit contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
import { useCallback, useState } from 'react';
import { listObsScenes, switchObsScene } from './api';
import { useIntervalPolling } from './useIntervalPolling';

const POLL_INTERVAL_MS = 5000;

export interface UseObsScenesResult {
  scenes: string[];
  current: string;
  loading: boolean;
  error: string | null;
  pending: string | null;
  switchScene: (sceneName: string) => Promise<void>;
}

export function useObsScenes(): UseObsScenesResult {
  const [scenes, setScenes] = useState<string[]>([]);
  const [current, setCurrent] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const data = await listObsScenes();
      setScenes(data.scenes);
      setCurrent(data.currentProgramScene);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load OBS scenes');
    } finally {
      setLoading(false);
    }
  }, []);

  useIntervalPolling(refresh, POLL_INTERVAL_MS);

  const switchScene = useCallback(
    async (sceneName: string) => {
      setPending(sceneName);
      setError(null);
      try {
        await switchObsScene(sceneName);
        setCurrent(sceneName);
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Failed to switch scene');
      } finally {
        setPending(null);
      }
    },
    [],
  );

  return { scenes, current, loading, error, pending, switchScene };
}
