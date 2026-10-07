'use client';
// SPDX-FileCopyrightText: 2026 OpenIRLNodeKit contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useEffect, useState } from 'react';
import {
  getMultistreamKeys,
  getObsStreamService,
  getSettings,
  saveSettings,
} from '../../lib/api';
import { useObsStreamSettings } from '../../lib/useObsStreamSettings';
import { Button, Field, Input } from '../ui';
import StreamKeysForm from './StreamKeysForm';
import StreamQualityForm from './StreamQualityForm';

/**
 * First-run setup. Shows only the fields the OINK_* env did not already
 * provide (channel / stream keys / video preset) and skips on demand. Finishing
 * or skipping marks the install's welcome complete server-side.
 */
export default function WelcomeForm() {
  const quality = useObsStreamSettings();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [channel, setChannel] = useState('');
  const [channelProvided, setChannelProvided] = useState(false);
  const [keysProvided, setKeysProvided] = useState(false);
  const [qualityProvided, setQualityProvided] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let live = true;
    Promise.all([
      getSettings(),
      getObsStreamService().catch(() => null),
      getMultistreamKeys().catch(() => null),
    ])
      .then(([settings, streamService, multistream]) => {
        if (!live) return;
        setChannel(settings.twitchChannel);
        setChannelProvided(settings.twitchChannel.trim().length > 0);
        setQualityProvided(settings.presetProvided);
        const platformKeys = Object.values(multistream?.platforms ?? {});
        setKeysProvided(
          streamService?.keyLast4 != null ||
            platformKeys.some((p) => p?.configured),
        );
      })
      .catch((e) => {
        if (live) setError(e instanceof Error ? e.message : 'Failed to load setup state');
      })
      .finally(() => {
        if (live) setLoading(false);
      });
    return () => {
      live = false;
    };
  }, []);

  const finish = async (complete: boolean) => {
    setSaving(true);
    setError(null);
    try {
      const patch: { welcomeComplete: boolean; twitchChannel?: string } = {
        welcomeComplete: true,
      };
      if (complete && !channelProvided) patch.twitchChannel = channel;
      await saveSettings(patch);
      window.location.replace('/dashboard');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to save');
      setSaving(false);
    }
  };

  const nothingMissing = channelProvided && keysProvided && qualityProvided;

  return (
    <div className="glow-hero min-h-screen px-4 py-12">
      <div className="mx-auto w-full max-w-2xl space-y-6">
        <div className="text-center">
          <h1 className="text-2xl font-semibold tracking-tight">Welcome to OINK</h1>
          <p className="mt-2 text-sm text-text-secondary">
            Let&apos;s get your node ready to stream. Anything already set from your
            config is filled in and can be left as is.
          </p>
        </div>

        {error && (
          <p className="text-sm text-danger" role="alert">
            {error}
          </p>
        )}

        {loading ? (
          <p className="text-center text-sm text-text-secondary">Loading…</p>
        ) : nothingMissing ? (
          <p className="text-center text-sm text-text-secondary">
            Everything is already configured.
          </p>
        ) : (
          <div className="space-y-6">
            {!channelProvided && (
              <div className="surface space-y-4 p-6">
                <div>
                  <h2 className="text-sm font-semibold tracking-tight">Channel</h2>
                  <p className="mt-0.5 text-[13px] text-text-secondary">
                    Your Twitch channel, used by the clips and chat overlays.
                  </p>
                </div>
                <Field label="Twitch channel name" htmlFor="welcome-channel">
                  <Input
                    id="welcome-channel"
                    name="welcome-channel"
                    placeholder="my_channel"
                    value={channel}
                    autoCapitalize="none"
                    autoCorrect="off"
                    onChange={(e) => setChannel(e.target.value)}
                  />
                </Field>
              </div>
            )}

            {!keysProvided && (
              <div className="surface space-y-4 p-6">
                <div>
                  <h2 className="text-sm font-semibold tracking-tight">
                    Stream keys
                  </h2>
                  <p className="mt-0.5 text-[13px] text-text-secondary">
                    Optional — pick where OBS publishes. Add later in Settings.
                  </p>
                </div>
                <StreamKeysForm />
              </div>
            )}

            {!qualityProvided && (
              <div className="surface space-y-4 p-6">
                <div>
                  <h2 className="text-sm font-semibold tracking-tight">
                    Video quality
                  </h2>
                  <p className="mt-0.5 text-[13px] text-text-secondary">
                    Resolution, framerate, and bitrate for the OBS output.
                  </p>
                </div>
                <StreamQualityForm
                  settings={quality.settings}
                  loading={quality.loading}
                  error={quality.error}
                  saving={quality.saving}
                  saveError={quality.saveError}
                  save={quality.save}
                />
              </div>
            )}
          </div>
        )}

        <div className="flex items-center justify-center gap-3">
          <Button
            variant="secondary"
            disabled={saving || loading}
            onClick={() => void finish(false)}
          >
            Skip for now
          </Button>
          <Button
            variant="primary"
            disabled={saving || loading}
            onClick={() => void finish(true)}
          >
            {saving ? 'Saving…' : 'Finish setup'}
          </Button>
        </div>
      </div>
    </div>
  );
}
