'use client';
// SPDX-FileCopyrightText: 2026 OpenIRLNodeKit contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useEffect, useRef, useState } from 'react';
import type { ObsEncoder, ObsStreamSettingsInput } from '../../lib/api';
import { getIngestInfo, rotateIngestInfo } from '../../lib/api';
import { useChannel } from '../../lib/useChannel';
import type { IngestInfo } from '../../lib/types';
import { useObsStreamSettings } from '../../lib/useObsStreamSettings';
import { Button, Field, Input, SecretField, Select } from '../ui';
import StreamQualityForm from './StreamQualityForm';

export default function StreamSettingsForm() {
  const { settings, loading, error, saving, saveError, save } =
    useObsStreamSettings();
  const { channel, setChannel } = useChannel();
  const [keyState, setKeyState] = useState<{
    status: 'loading' | 'ok' | 'error';
    info?: IngestInfo;
    error?: string;
  }>({ status: 'loading' });
  const [confirmRotate, setConfirmRotate] = useState(false);
  const [rotating, setRotating] = useState(false);
  const [rotateError, setRotateError] = useState<string | null>(null);
  const rotateTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (rotateTimer.current) clearTimeout(rotateTimer.current);
    };
  }, []);

  useEffect(() => {
    getIngestInfo()
      .then((info) => setKeyState({ status: 'ok', info }))
      .catch((e) => {
        setKeyState({
          status: 'error',
          error: e instanceof Error ? e.message : 'Failed to load ingest key',
        });
      });
  }, []);

  const encoder = (settings?.encoder ?? 'x264') as ObsEncoder;

  const applyEncoder = (next: ObsEncoder) => {
    if (!settings) return;
    const input: ObsStreamSettingsInput = {
      encoder: next,
      outputWidth: settings.outputWidth,
      outputHeight: settings.outputHeight,
      fpsNumerator: settings.fpsNumerator,
      fpsDenominator: settings.fpsDenominator,
      bitrate: settings.bitrate,
    };
    void save(input);
  };

  const handleRotate = async () => {
    if (confirmRotate) {
      if (rotateTimer.current) clearTimeout(rotateTimer.current);
      rotateTimer.current = null;
      setConfirmRotate(false);
      setRotating(true);
      setRotateError(null);
      try {
        const info = await rotateIngestInfo();
        setKeyState({ status: 'ok', info });
      } catch (e) {
        setRotateError(e instanceof Error ? e.message : 'Rotation failed');
      } finally {
        setRotating(false);
      }
      return;
    }
    setConfirmRotate(true);
    rotateTimer.current = setTimeout(() => setConfirmRotate(false), 5000);
  };

  const disabled = loading || !settings || settings.streamActive || saving;

  return (
    <div className="space-y-4">
      <Field
        label="Channel name"
        htmlFor="stream-channel"
        hint="Your Twitch channel; used by Twitch Clips and the chat overlay"
      >
        <Input
          id="stream-channel"
          name="channel"
          placeholder="my_channel"
          value={channel}
          onChange={(e) => setChannel(e.target.value)}
        />
      </Field>

      <div className="border-t border-border-subtle" />

      {keyState.status === 'loading' && (
        <p className="text-sm text-text-secondary">Loading ingest key…</p>
      )}
      {keyState.status === 'error' && (
        <p className="text-sm text-danger" role="alert">
          Failed to read ingest key: {keyState.error}
        </p>
      )}
      {keyState.status === 'ok' && keyState.info && (
        <>
          <SecretField
            id="ingest-stream-key"
            label="Ingest key"
            value={keyState.info.key}
            hint="Secret key that gates publishing to this node — anyone with it can
              publish, so keep it private and rotate it if it leaks."
          />
          <div>
            <Button
              size="sm"
              variant={confirmRotate ? 'danger' : 'secondary'}
              onClick={handleRotate}
              disabled={rotating}
            >
              {rotating
                ? 'Rotating…'
                : confirmRotate
                  ? 'Confirm rotate — re-provision OBS and reconnect phones'
                  : 'Rotate ingest key'}
            </Button>
            {rotateError && (
              <p className="text-sm text-danger mt-2" role="alert">
                Rotation failed: {rotateError}
              </p>
            )}
          </div>
        </>
      )}

      <Field label="Encoder" htmlFor="stream-encoder">
        <Select
          id="stream-encoder"
          value={encoder}
          onChange={(e) => applyEncoder(e.target.value as ObsEncoder)}
          disabled={disabled}
        >
          <option value="x264">x264 (software)</option>
          {settings?.hasNvenc && <option value="nvenc">NVENC (NVIDIA)</option>}
        </Select>
      </Field>

      <StreamQualityForm
        settings={settings}
        loading={loading}
        error={error}
        saving={saving}
        saveError={saveError}
        save={save}
      />
    </div>
  );
}
