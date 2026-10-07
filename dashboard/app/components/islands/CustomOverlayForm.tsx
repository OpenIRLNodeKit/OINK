"use client";
// SPDX-FileCopyrightText: 2026 OpenIRLNodeKit contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useObsBrowserSource } from '../../lib/useObsBrowserSource';
import { Field, Input, Toggle } from '../ui';
import OverlayFormShell from './OverlayFormShell';

const CUSTOM_OVERLAY_STORAGE_KEY = 'oink_custom_overlay_config';

const SCENES = ['main', 'brb', 'privacy', 'offline', 'low-br'] as const;

interface CustomOverlayConfig {
  sourceName: string;
  url: string;
  rerouteAudio: boolean;
}

const DEFAULT_CONFIG = {
  sourceName: 'custom_overlay',
  url: '',
  rerouteAudio: true,
};

export default function CustomOverlayForm() {
  const [config, setConfig] = useState<CustomOverlayConfig>(DEFAULT_CONFIG);
  const [hydrated, setHydrated] = useState(false);

  useEffect(() => {
    try {
      const raw = localStorage.getItem(CUSTOM_OVERLAY_STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw) as Partial<CustomOverlayConfig>;
        setConfig({ ...DEFAULT_CONFIG, ...parsed });
      }
    } catch {
      // ignore malformed stored config
    }
    setHydrated(true);
  }, []);

  useEffect(() => {
    if (!hydrated) return;
    localStorage.setItem(CUSTOM_OVERLAY_STORAGE_KEY, JSON.stringify(config));
  }, [config, hydrated]);

  const sourceName = config.sourceName.trim() || DEFAULT_CONFIG.sourceName;
  const url = useMemo(() => config.url.trim(), [config.url]);
  const urlMissing = !config.url.trim();

  const form = useObsBrowserSource({
    url,
    widgetName: sourceName,
    rerouteAudio: config.rerouteAudio,
  });

  const update = useCallback(<K extends keyof CustomOverlayConfig>(
    key: K,
    value: CustomOverlayConfig[K],
  ) => {
    setConfig((prev) => ({ ...prev, [key]: value }));
  }, []);

  return (
    <OverlayFormShell
      url={url}
      canApply={!urlMissing}
      missingText="Enter the overlay URL above to apply it to OBS."
      sceneOptions={SCENES}
      form={form}
    >
      <div className="space-y-4">
        <h4 className="text-sm font-semibold text-text-primary">Source</h4>
        <p className="text-[13px] text-text-secondary">
          Add any browser-source overlay URL to your OBS scenes. Useful for
          overlays not covered by the Twitch Clips or Chat builders.
        </p>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Field
            label="OBS source name"
            htmlFor="cov-name"
            hint="Appears in your OBS sources list"
          >
            <Input
              id="cov-name"
              name="sourceName"
              placeholder="custom_overlay"
              value={config.sourceName}
              onChange={(e) => update('sourceName', e.target.value)}
            />
          </Field>
          <Field
            label="Reroute audio"
            htmlFor="cov-audio"
            hint="Route the overlay's audio into OBS"
          >
            <Toggle
              id="cov-audio"
              name="rerouteAudio"
              label="Route audio to OBS"
              checked={config.rerouteAudio}
              onChange={() => update('rerouteAudio', !config.rerouteAudio)}
            />
          </Field>
        </div>
        <Field
          label="OBS Source URL"
          htmlFor="cov-url"
          hint="Paste the full browser-source URL"
        >
          <Input
            id="cov-url"
            name="url"
            placeholder="https://…"
            value={config.url}
            onChange={(e) => update('url', e.target.value)}
          />
        </Field>
      </div>
    </OverlayFormShell>
  );
}
