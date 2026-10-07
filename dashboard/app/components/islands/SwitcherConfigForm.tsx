"use client";
// SPDX-FileCopyrightText: 2026 OpenIRLNodeKit contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useCallback, useEffect, useState } from 'react';
import { getNoalbsConfig, saveNoalbsConfig } from '../../lib/api';
import type { NoalbsConfig } from '../../lib/types';
import { Button, Field, Input, Toggle } from '../ui';

type SaveState = 'idle' | 'saving' | 'saved' | 'error';

export default function SwitcherConfigForm() {
  const [config, setConfig] = useState<NoalbsConfig | null>(null);
  const [enabled, setEnabled] = useState(true);
  const [low, setLow] = useState('900');
  const [offline, setOffline] = useState('300');
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saveState, setSaveState] = useState<SaveState>('idle');
  const [saveError, setSaveError] = useState<string | null>(null);

  const loadConfig = useCallback(async () => {
    try {
      const cfg = await getNoalbsConfig();
      setConfig(cfg);
      setEnabled(cfg.switcher?.bitrateSwitcherEnabled ?? true);
      setLow(String(cfg.switcher?.triggers?.low ?? 900));
      setOffline(String(cfg.switcher?.triggers?.offline ?? 300));
      setLoadError(null);
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : 'Failed to load config');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadConfig();
  }, [loadConfig]);

  const handleSave = async () => {
    setSaveState('saving');
    setSaveError(null);
    try {
      const cfg: NoalbsConfig = config ? structuredClone(config) : {};
      cfg.switcher = {
        ...cfg.switcher,
        bitrateSwitcherEnabled: enabled,
        triggers: {
          low: Math.max(0, Number(low) || 0),
          offline: Math.max(0, Number(offline) || 0),
        },
      };
      await saveNoalbsConfig(cfg);
      setConfig(cfg);
      setSaveState('saved');
    } catch (e) {
      setSaveState('error');
      setSaveError(e instanceof Error ? e.message : 'Failed to save config');
    }
  };

  const showToast = saveState === 'saved' || saveState === 'error';

  return (
    <div className="space-y-4">
      <Toggle
        name="auto-switch-toggle"
        label="Enable Auto Switching"
        description="Automatically switch scenes based on bitrate"
        checked={enabled}
        onChange={(e) => setEnabled(e.target.checked)}
        disabled={loading}
      />

      <div className="grid grid-cols-2 gap-4">
        <Field
          label="Low Bitrate Threshold"
          htmlFor="low-threshold"
          hint="kbps"
        >
          <Input
            id="low-threshold"
            type="number"
            min={0}
            value={low}
            onChange={(e) => setLow(e.target.value)}
            disabled={loading}
          />
        </Field>
        <Field
          label="Offline Threshold"
          htmlFor="offline-threshold"
          hint="kbps"
        >
          <Input
            id="offline-threshold"
            type="number"
            min={0}
            value={offline}
            onChange={(e) => setOffline(e.target.value)}
            disabled={loading}
          />
        </Field>
      </div>

      <div className="flex items-center gap-3">
        <Button
          onClick={handleSave}
          disabled={loading || saveState === 'saving'}
        >
          {saveState === 'saving' ? 'Saving…' : 'Save'}
        </Button>
        <div
          role="status"
          className={`whitespace-nowrap px-3 py-1.5 rounded-lg text-sm font-medium transition-opacity duration-300 ${
            showToast
              ? 'opacity-100 ' +
                (
                  saveState === 'saved'
                    ? 'bg-success-soft text-success'
                    : 'bg-danger-soft text-danger'
                )
              : 'opacity-0'
          }`}
        >
          {saveState === 'saved' ? 'Saved' : saveError}
        </div>
      </div>

      {loading && (
        <p className="text-sm text-text-secondary">Loading configuration…</p>
      )}
      {loadError && (
        <p className="text-sm text-danger" role="alert">
          Failed to load config: {loadError}
        </p>
      )}
    </div>
  );
}
