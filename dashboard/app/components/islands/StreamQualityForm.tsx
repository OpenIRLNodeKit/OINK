'use client';
// SPDX-FileCopyrightText: 2026 OpenIRLNodeKit contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useEffect, useRef, useState } from 'react';
import type { ObsStreamSettingsInput } from '../../lib/api';
import type { UseObsStreamSettingsResult } from '../../lib/useObsStreamSettings';
import { formatResolution } from '../../lib/useObsStreamSettings';
import { Button, Field, Input, Select } from '../ui';

interface Resolution {
  label: string;
  outputWidth: number;
  outputHeight: number;
  recommendedBitrate: number;
}

// Resolution tiers. 2K (1440p) tops out at 9 Mbps, 1080p at 7.5 Mbps.
const RESOLUTIONS: Resolution[] = [
  {
    label: '1440p (2K)',
    outputWidth: 2560,
    outputHeight: 1440,
    recommendedBitrate: 9000,
  },
  {
    label: '1080p',
    outputWidth: 1920,
    outputHeight: 1080,
    recommendedBitrate: 7500,
  },
  {
    label: '720p',
    outputWidth: 1280,
    outputHeight: 720,
    recommendedBitrate: 4500,
  },
];

// OBS "Common FPS Values" (integer 60/30).
const FRAMERATES = [60, 30];

const BITRATES = [9000, 7500, 6000, 4500, 3000];

const CUSTOM = 'custom';

interface Draft {
  outputWidth: number;
  outputHeight: number;
  fps: number;
  bitrate: number;
}

const resId = (r: { outputWidth: number; outputHeight: number }) =>
  `${r.outputWidth}x${r.outputHeight}`;

type QualityProps = Pick<
  UseObsStreamSettingsResult,
  'settings' | 'loading' | 'error' | 'saving' | 'saveError' | 'save'
>;

/**
 * Resolution / framerate / bitrate selector + Apply. Shared by Settings →
 * Stream Settings and the first-run welcome screen; the parent owns the
 * `useObsStreamSettings` hook so the encoder select and quality stay in sync.
 */
export default function StreamQualityForm({
  settings,
  loading,
  error,
  saving,
  saveError,
  save,
}: QualityProps) {
  const [saved, setSaved] = useState(false);
  const [draft, setDraft] = useState<Draft>({
    outputWidth: 1920,
    outputHeight: 1080,
    fps: 60,
    bitrate: 6000,
  });
  const [customBitrate, setCustomBitrate] = useState(false);
  const [customText, setCustomText] = useState('6000');
  const [bitrateError, setBitrateError] = useState<string | null>(null);
  const syncedKey = useRef<string | null>(null);
  const savedTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (savedTimer.current) clearTimeout(savedTimer.current);
    };
  }, []);

  const encoder = settings?.encoder ?? 'x264';

  const settingsKey = settings
    ? `${settings.outputWidth}x${settings.outputHeight}|${Math.round(
        settings.fpsNumerator / settings.fpsDenominator,
      )}|${settings.bitrate}`
    : null;

  useEffect(() => {
    if (!settings || settingsKey === syncedKey.current) return;
    syncedKey.current = settingsKey;
    setDraft({
      outputWidth: settings.outputWidth,
      outputHeight: settings.outputHeight,
      fps: Math.round(settings.fpsNumerator / settings.fpsDenominator),
      bitrate: settings.bitrate,
    });
    setCustomBitrate(!BITRATES.includes(settings.bitrate));
    setCustomText(String(settings.bitrate));
    setBitrateError(null);
  }, [settings, settingsKey]);

  const currentFps = settings
    ? Math.round(settings.fpsNumerator / settings.fpsDenominator)
    : null;
  const parsedCustom = Number(customText);
  const draftBitrate = customBitrate ? parsedCustom : draft.bitrate;
  const dirty =
    !!settings &&
    (draft.outputWidth !== settings.outputWidth ||
      draft.outputHeight !== settings.outputHeight ||
      draft.fps !== currentFps ||
      draftBitrate !== settings.bitrate);

  const applyDraft = async () => {
    if (!settings) return;
    if (!Number.isInteger(draftBitrate) || draftBitrate <= 0) {
      setBitrateError('Bitrate must be a positive whole number (kbps)');
      return;
    }
    setBitrateError(null);
    const input: ObsStreamSettingsInput = {
      encoder,
      outputWidth: draft.outputWidth,
      outputHeight: draft.outputHeight,
      fpsNumerator: draft.fps,
      fpsDenominator: 1,
      bitrate: draftBitrate,
    };
    const ok = await save(input);
    if (ok) {
      setSaved(true);
      if (savedTimer.current) clearTimeout(savedTimer.current);
      savedTimer.current = setTimeout(() => setSaved(false), 3000);
    }
  };

  const applyResolution = (id: string) => {
    const res = RESOLUTIONS.find((r) => resId(r) === id);
    if (!res) return;
    setDraft((d) => ({
      ...d,
      outputWidth: res.outputWidth,
      outputHeight: res.outputHeight,
      bitrate: res.recommendedBitrate,
    }));
    setCustomBitrate(false);
    setCustomText(String(res.recommendedBitrate));
    setBitrateError(null);
  };

  const disabled = loading || !settings || settings.streamActive || saving;
  const resolution = formatResolution(settings);

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2 text-sm">
        <span className="text-xs font-medium uppercase tracking-[0.12em] text-text-faint">
          Current
        </span>
        <span className="tabular text-text-primary">{resolution ?? '—'}</span>
        <span className="text-text-faint">·</span>
        <span className="tabular text-text-primary">
          {settings ? `${settings.bitrate} kbps` : '—'}
        </span>
      </div>

      <Field label="Resolution" htmlFor="stream-resolution">
        <Select
          id="stream-resolution"
          value={resId(draft)}
          onChange={(e) => applyResolution(e.target.value)}
          disabled={disabled}
        >
          {!RESOLUTIONS.some((r) => resId(r) === resId(draft)) && (
            <option value={resId(draft)}>{`${draft.outputHeight}p`}</option>
          )}
          {RESOLUTIONS.map((r) => (
            <option key={resId(r)} value={resId(r)}>
              {r.label}
            </option>
          ))}
        </Select>
      </Field>

      <Field label="Framerate" htmlFor="stream-framerate">
        <Select
          id="stream-framerate"
          value={String(draft.fps)}
          onChange={(e) => setDraft((d) => ({ ...d, fps: Number(e.target.value) }))}
          disabled={disabled}
        >
          {!FRAMERATES.includes(draft.fps) && (
            <option value={String(draft.fps)}>{`${draft.fps} fps`}</option>
          )}
          {FRAMERATES.map((f) => (
            <option key={f} value={String(f)}>
              {`${f} fps`}
            </option>
          ))}
        </Select>
      </Field>

      <Field
        label="Bitrate"
        htmlFor="stream-bitrate"
        error={bitrateError ?? undefined}
      >
        <Select
          id="stream-bitrate"
          value={customBitrate ? CUSTOM : String(draft.bitrate)}
          onChange={(e) => {
            const value = e.target.value;
            if (value === CUSTOM) {
              setCustomBitrate(true);
              return;
            }
            setCustomBitrate(false);
            setDraft((d) => ({ ...d, bitrate: Number(value) }));
            setBitrateError(null);
          }}
          disabled={disabled}
        >
          {BITRATES.map((b) => (
            <option key={b} value={String(b)}>
              {`${b} kbps`}
            </option>
          ))}
          <option value={CUSTOM}>Custom…</option>
        </Select>
      </Field>

      {customBitrate && (
        <Field label="Custom bitrate (kbps)" htmlFor="stream-bitrate-custom">
          <Input
            id="stream-bitrate-custom"
            type="number"
            inputMode="numeric"
            min={1}
            step={1}
            value={customText}
            onChange={(e) => {
              setCustomText(e.target.value);
              setBitrateError(null);
            }}
            disabled={disabled}
          />
        </Field>
      )}

      <Button
        onClick={applyDraft}
        disabled={disabled || !dirty}
        size="sm"
        variant="primary"
      >
        {saving ? 'Applying…' : 'Apply'}
      </Button>

      {settings?.streamActive && (
        <p className="text-sm text-warning" role="status">
          Stop the stream, recording, and virtual camera to change these settings.
        </p>
      )}

      {loading && (
        <p className="text-sm text-text-secondary">Loading stream settings…</p>
      )}
      {error && (
        <p className="text-sm text-danger" role="alert">
          Failed to load stream settings: {error}
        </p>
      )}

      {(saving || saved || saveError) && (
        <p
          className={`text-sm font-medium ${
            saveError
              ? 'text-danger'
              : saved
                ? 'text-success'
                : 'text-text-secondary'
          }`}
          role={saveError ? 'alert' : 'status'}
          aria-live="polite"
        >
          {saveError ? saveError : saving ? 'Saving…' : 'Saved'}
        </p>
      )}
    </div>
  );
}
