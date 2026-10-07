"use client";
// SPDX-FileCopyrightText: 2026 OpenIRLNodeKit contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useCallback, useEffect, useState } from 'react';
import {
  getMultistreamKeys,
  getObsStreamService,
  getPrimaryPlatform,
  restartObs,
  setObsStreamServiceKey,
  setPrimaryPlatform,
  saveMultistreamKeys,
  type MultistreamKeys,
  type MultistreamPlatform,
  type Platform,
} from '../../lib/api';
import { Button, Field, Input } from '../ui';

const PLATFORMS: { id: Platform; label: string }[] = [
  { id: 'twitch', label: 'Twitch' },
  { id: 'youtube', label: 'YouTube' },
  { id: 'kick', label: 'Kick' },
  { id: 'custom-rtmp', label: 'Custom RTMP' },
];

const MULTISTREAM_PLATFORMS: { id: MultistreamPlatform; label: string }[] = [
  { id: 'twitch', label: 'Twitch' },
  { id: 'youtube', label: 'YouTube' },
  { id: 'kick', label: 'Kick' },
];

type Busy = null | 'saving' | 'restarting' | 'loading';

interface Notice {
  tone: 'ok' | 'error';
  text: string;
}

export default function StreamKeysForm() {
  const [loading, setLoading] = useState(true);
  const [primaryPlatform, setPrimaryPlatformState] = useState<Platform>('twitch');
  const [primaryKeyLast4, setPrimaryKeyLast4] = useState<string | null>(null);
  const [primaryKeyConfigured, setPrimaryKeyConfigured] = useState(false);
  const [multistreamKeys, setMultistreamKeys] = useState<MultistreamKeys>({});

  const [primaryKeyValue, setPrimaryKeyValue] = useState('');
  const [customServer, setCustomServer] = useState('');
  const [multistreamValues, setMultistreamValues] = useState<Record<string, string>>({});
  const [visible, setVisible] = useState<Record<string, boolean>>({});

  const [busy, setBusy] = useState<Busy>(null);
  const [restartPending, setRestartPending] = useState(false);
  const [notice, setNotice] = useState<Notice | null>(null);

  const isCustomPrimary = primaryPlatform === 'custom-rtmp';
  const multistreamPlatforms = MULTISTREAM_PLATFORMS.filter(
    (p) => p.id !== primaryPlatform,
  );

  const refresh = useCallback(async () => {
    try {
      const [platform, streamService, multistream] = await Promise.all([
        getPrimaryPlatform(),
        getObsStreamService(),
        getMultistreamKeys(),
      ]);

      setPrimaryPlatformState(platform);
      setPrimaryKeyLast4(streamService.keyLast4);
      setPrimaryKeyConfigured(streamService.keyLast4 !== null);
      if (platform === 'custom-rtmp') setCustomServer(streamService.server || '');
      setMultistreamKeys(multistream.platforms);
    } catch (e) {
      setNotice({
        tone: 'error',
        text: e instanceof Error ? e.message : 'Failed to load stream keys',
      });
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const handlePrimaryPlatformChange = async (platform: Platform) => {
    if (platform === primaryPlatform) return;

    // Custom RTMP needs a server URL, so defer the switch to Save (which sends
    // platform + server together). Known platforms switch immediately.
    if (platform === 'custom-rtmp') {
      setPrimaryPlatformState('custom-rtmp');
      setPrimaryKeyValue('');
      setMultistreamValues({});
      setNotice({ tone: 'ok', text: 'Enter the RTMP server URL and stream key, then Save.' });
      return;
    }

    setBusy('saving');
    setNotice(null);
    try {
      await setPrimaryPlatform(platform);
      setPrimaryPlatformState(platform);
      setPrimaryKeyValue('');
      setMultistreamValues({});
      setRestartPending(true);
      setNotice({ tone: 'ok', text: 'Primary platform updated.' });
      await refresh();
    } catch (e) {
      setNotice({
        tone: 'error',
        text: e instanceof Error ? e.message : 'Failed to update primary platform',
      });
    } finally {
      setBusy(null);
    }
  };

  const anyFilled =
    primaryKeyValue.trim().length > 0 ||
    multistreamPlatforms.some((p) => multistreamValues[p.id]?.trim().length > 0);

  const handleSave = async () => {
    if (isCustomPrimary && !customServer.trim()) {
      setNotice({ tone: 'error', text: 'Enter the RTMP server URL (rtmp:// or rtmps://).' });
      return;
    }
    if (!anyFilled && !isCustomPrimary) {
      setNotice({ tone: 'error', text: 'Enter at least one stream key.' });
      return;
    }
    
    // Check if we're saving multistream keys (not just primary)
    const hasMultistreamKeys = multistreamPlatforms.some((p) => multistreamValues[p.id]?.trim());
    
    if (hasMultistreamKeys) {
      const confirmed = window.confirm(
        'Saving multistream keys will automatically restart OBS. This will briefly interrupt any active streams. Continue?'
      );
      if (!confirmed) return;
    }
    
    setBusy('saving');
    setNotice(null);
    try {
      // Custom RTMP: apply the platform + server first (this preserves the
      // current key), then the key save below overwrites it.
      if (isCustomPrimary) {
        await setPrimaryPlatform('custom-rtmp', customServer.trim());
      }

      // Save primary key if filled
      if (primaryKeyValue.trim()) {
        await setObsStreamServiceKey(primaryKeyValue.trim());
      }

      // Save multistream keys if any are filled
      const multistreamKeysToSave: Partial<Record<MultistreamPlatform, string>> = {};
      for (const p of multistreamPlatforms) {
        const key = multistreamValues[p.id]?.trim();
        if (key) multistreamKeysToSave[p.id] = key;
      }
      const savedMultistream = Object.keys(multistreamKeysToSave).length > 0;
      if (savedMultistream) {
        await saveMultistreamKeys(multistreamKeysToSave);
      }

      setPrimaryKeyValue('');
      setMultistreamValues({});
      if (savedMultistream) {
        // The multistream save path restarts OBS itself — nothing pending.
        setRestartPending(false);
        setNotice({ tone: 'ok', text: 'Stream keys saved — OBS restarted automatically.' });
      } else {
        // Only the primary key was saved: OBS is not restarted, so the key is
        // not live until the operator restarts (or re-provisions).
        setRestartPending(true);
        setNotice({ tone: 'ok', text: 'Primary stream key saved — restart OBS to apply.' });
      }
      await refresh();
    } catch (e) {
      setNotice({
        tone: 'error',
        text: e instanceof Error ? e.message : 'Failed to save stream keys',
      });
    } finally {
      setBusy(null);
    }
  };

  const handleRestart = async () => {
    setBusy('restarting');
    setNotice(null);
    try {
      await restartObs();
      setNotice({ tone: 'ok', text: 'OBS restarted' });
      setRestartPending(false);
    } catch (e) {
      setNotice({
        tone: 'error',
        text: e instanceof Error ? e.message : 'Failed to restart OBS',
      });
    } finally {
      setBusy(null);
    }
  };

  const handleClear = () => {
    setPrimaryKeyValue('');
    setMultistreamValues({});
    setNotice(null);
  };

  const primaryPlatformLabel = PLATFORMS.find((p) => p.id === primaryPlatform)?.label || 'Twitch';
  const primaryHint = primaryKeyConfigured
    ? `Currently set (••••${primaryKeyLast4 ?? ''}) — leave empty to keep`
    : 'No key saved yet';

  return (
    <div className="space-y-6">
      <p className="text-[13px] leading-relaxed text-text-secondary">
        Choose the destination for OBS&apos;s built-in output — a platform or a custom
        RTMP server. Any remaining platforms stream as optional extras via the Aitum
        Multistream plugin.
      </p>

      {/* Primary Platform Selector */}
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-4">
        {PLATFORMS.map((p) => {
          const isSelected = primaryPlatform === p.id;
          return (
            <button
              key={p.id}
              type="button"
              disabled={busy !== null}
              onClick={() => void handlePrimaryPlatformChange(p.id)}
              className={`flex flex-col items-start rounded-lg border p-4 text-left transition-all ${
                isSelected
                  ? 'border-primary bg-primary/10 ring-2 ring-primary/30'
                  : 'border-border-subtle bg-bg-card hover:border-border hover:bg-bg-elevated'
              } disabled:opacity-50`}
            >
              <span
                className={`text-sm font-semibold ${
                  isSelected ? 'text-primary' : 'text-text-primary'
                }`}
              >
                {p.label}
              </span>
              {isSelected ? (
                <span className="mt-1 text-xs font-medium text-primary">
                  Primary (Built-in)
                </span>
              ) : (
                <span className="mt-1 text-xs text-text-secondary">
                  {p.id === 'custom-rtmp' ? 'Custom server' : 'Multistream'}
                </span>
              )}
            </button>
          );
        })}
      </div>

      {/* Primary Stream Key */}
      <div className="space-y-4">
        {isCustomPrimary && (
          <Field
            label="RTMP server URL"
            htmlFor="custom-rtmp-server"
            hint="Any RTMP/RTMPS ingest endpoint, e.g. rtmp://ingest.example.com/live"
          >
            <Input
              id="custom-rtmp-server"
              name="custom-rtmp-server"
              type="text"
              autoComplete="off"
              spellCheck={false}
              placeholder="rtmp://ingest.example.com/live"
              value={customServer}
              disabled={busy !== null}
              onChange={(e) => setCustomServer(e.target.value)}
            />
          </Field>
        )}
        <Field
          label={`${primaryPlatformLabel} stream key`}
          htmlFor="primary-stream-key"
          hint={primaryHint}
        >
          <div className="relative">
            <Input
              id="primary-stream-key"
              name="stream-key"
              type={visible['primary'] ? 'text' : 'password'}
              autoComplete="off"
              spellCheck={false}
              placeholder="Paste your stream key"
              value={primaryKeyValue}
              disabled={busy !== null}
              onChange={(e) => setPrimaryKeyValue(e.target.value)}
              className="pr-16"
            />
            <button
              type="button"
              aria-label={`${visible['primary'] ? 'Hide' : 'Show'} ${primaryPlatformLabel} key`}
              onClick={() => setVisible((v) => ({ ...v, primary: !v.primary }))}
              className="absolute inset-y-0 right-0 px-3 text-xs font-medium text-text-secondary transition-colors hover:text-primary disabled:opacity-50"
              disabled={busy !== null}
            >
              {visible['primary'] ? 'Hide' : 'Show'}
            </button>
          </div>
        </Field>
      </div>

      {/* Multistream Keys */}
      <div className="space-y-4">
        <h3 className="text-sm font-semibold text-text-primary">
          Multistream Keys (Aitum plugin)
        </h3>
        <div className="space-y-3">
          {multistreamPlatforms.map((p) => {
            const platform = multistreamKeys[p.id];
            const hint = platform?.configured
              ? `Currently set (••••${platform.last4 ?? ''}) — leave empty to keep`
              : 'No key saved yet';
            return (
              <Field key={p.id} label={p.label} htmlFor={`multistream-${p.id}`} hint={hint}>
                <div className="relative">
                  <Input
                    id={`multistream-${p.id}`}
                    name={p.id}
                    type={visible[p.id] ? 'text' : 'password'}
                    autoComplete="off"
                    spellCheck={false}
                    placeholder="Paste your stream key"
                    value={multistreamValues[p.id] || ''}
                    disabled={busy !== null}
                    onChange={(e) =>
                      setMultistreamValues((v) => ({ ...v, [p.id]: e.target.value }))
                    }
                    className="pr-16"
                  />
                  <button
                    type="button"
                    aria-label={`${visible[p.id] ? 'Hide' : 'Show'} ${p.label} key`}
                    onClick={() => setVisible((v) => ({ ...v, [p.id]: !v[p.id] }))}
                    className="absolute inset-y-0 right-0 px-3 text-xs font-medium text-text-secondary transition-colors hover:text-primary disabled:opacity-50"
                    disabled={busy !== null}
                  >
                    {visible[p.id] ? 'Hide' : 'Show'}
                  </button>
                </div>
              </Field>
            );
          })}
        </div>
      </div>

      {/* Action Buttons */}
      <div className="flex flex-wrap gap-2">
        <Button
          variant="primary"
          disabled={busy !== null || loading || (!anyFilled && !isCustomPrimary)}
          onClick={() => void handleSave()}
        >
          {busy === 'saving' ? 'Saving…' : isCustomPrimary ? 'Save destination' : 'Save all keys'}
        </Button>
        {anyFilled && (
          <Button variant="ghost" disabled={busy !== null} onClick={handleClear}>
            Clear
          </Button>
        )}
      </div>

      {/* Restart Prompt */}
      {restartPending && (
        <div className="flex flex-wrap items-center gap-3 rounded-lg bg-warning/10 p-3 ring-1 ring-inset ring-warning/30">
          <p className="text-[13px] text-text-primary">
            Restart OBS to apply the changes?
          </p>
          <div className="flex gap-2">
            <Button
              size="sm"
              variant="warning"
              disabled={busy !== null}
              onClick={() => void handleRestart()}
            >
              {busy === 'restarting' ? 'Restarting…' : 'Restart OBS now'}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              disabled={busy !== null}
              onClick={() => setRestartPending(false)}
            >
              Later
            </Button>
          </div>
        </div>
      )}

      {loading && (
        <p className="text-xs text-text-secondary">Loading stream keys…</p>
      )}

      {notice && (
        <p
          role="status"
          className={`text-[13px] ${notice.tone === 'ok' ? 'text-success' : 'text-danger'}`}
        >
          {notice.text}
        </p>
      )}
    </div>
  );
}
