// SPDX-FileCopyrightText: 2026 OpenIRLNodeKit contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
import { useCallback, useState } from 'react';
import { getObsStreamSettings, setObsStreamSettings } from './api';
import type { ObsStreamSettings, ObsStreamSettingsInput } from './api';
import { useIntervalPolling } from './useIntervalPolling';

const POLL_INTERVAL_MS = 5000;

export function formatResolution(
  settings:
    | Pick<
        ObsStreamSettings,
        'outputWidth' | 'outputHeight' | 'fpsNumerator' | 'fpsDenominator'
      >
    | null
    | undefined,
): string | null {
  if (!settings || !settings.outputHeight || !settings.fpsDenominator) {
    return null;
  }
  const fps = Math.round(settings.fpsNumerator / settings.fpsDenominator);
  return `${settings.outputHeight}p${fps}`;
}

export interface UseObsStreamSettingsResult {
  settings: ObsStreamSettings | null;
  lastUpdated: Date | null;
  loading: boolean;
  error: string | null;
  saving: boolean;
  saveError: string | null;
  refresh: () => Promise<void>;
  save: (input: ObsStreamSettingsInput) => Promise<boolean>;
}

export function useObsStreamSettings(): UseObsStreamSettingsResult {
  const [settings, setSettings] = useState<ObsStreamSettings | null>(null);
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const data = await getObsStreamSettings();
      setSettings(data);
      setLastUpdated(new Date());
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load OBS stream settings');
    } finally {
      setLoading(false);
    }
  }, []);

  useIntervalPolling(refresh, POLL_INTERVAL_MS);

  const save = useCallback(async (input: ObsStreamSettingsInput) => {
    setSaving(true);
    setSaveError(null);
    try {
      const data = await setObsStreamSettings(input);
      setSettings(data);
      return true;
    } catch (e) {
      setSaveError(e instanceof Error ? e.message : 'Failed to save OBS stream settings');
      return false;
    } finally {
      setSaving(false);
    }
  }, []);

  return { settings, lastUpdated, loading, error, saving, saveError, refresh, save };
}
