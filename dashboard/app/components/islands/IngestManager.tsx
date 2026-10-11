'use client';
// SPDX-FileCopyrightText: 2026 OpenIRLNodeKit contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { QRCodeSVG } from 'qrcode.react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  deleteObsMediaSource,
  getIngestInfo,
  getIngestProfiles,
  getIrlSourceStatus,
  provisionObsMediaSource,
  saveIngestProfiles,
} from '../../lib/api';
import { cn } from '../../lib/cn';
import {
  type Encoder,
  generateDeepLink,
  generateIngestUrls,
  generateLiveUDetails,
  generateObsReadUrl,
  generateSrtlaDetails,
  INGEST_RESERVED_LABEL,
} from '../../lib/ingest';
import type { IngestInfo } from '../../lib/types';
import { useIntervalPolling } from '../../lib/useIntervalPolling';
import { Badge, Button, Field, Input } from '../ui';
import ProtocolCard from './ingest/ProtocolCard';

const REFRESH_MS = 10000;

const IRL_PRO_STORE_URL =
  'https://play.google.com/store/apps/details?id=app.irlpro.android';
const MOBLIN_STORE_URL = 'https://apps.apple.com/us/app/moblin/id6466745933';
const IRLWHATEVER_STORE_URL =
  'https://play.google.com/store/apps/details?id=com.irlwhatever.app';

interface ProvisionState {
  status: 'idle' | 'ok' | 'error';
  message: string;
}

interface KeyState {
  status: 'loading' | 'ok' | 'error';
  info?: IngestInfo;
  error?: string;
}

export default function IngestManager() {
  const [streamName, setStreamName] = useState('');
  const [host, setHost] = useState('');
  const [profiles, setProfiles] = useState<string[]>([]);
  const [main, setMain] = useState<string>(INGEST_RESERVED_LABEL);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const confirmTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [keyState, setKeyState] = useState<KeyState>({ status: 'loading' });
  const [provision, setProvision] = useState<ProvisionState>({
    status: 'idle',
    message: '',
  });
  const [irlAvailable, setIrlAvailable] = useState(true);

  // Key + profiles are server state that can change while this page is open
  // (key rotation, profile edits in another tab), so poll like the other data
  // pages. useIntervalPolling fires once on mount, so no separate initial load.
  const refresh = useCallback(async () => {
    getIngestProfiles()
      .then((state) => {
        setProfiles(state.profiles);
        setMain(state.main);
      })
      .catch(() => {});
    try {
      setKeyState({ status: 'ok', info: await getIngestInfo() });
    } catch (e) {
      setKeyState({
        status: 'error',
        error: e instanceof Error ? e.message : 'Failed to load stream key',
      });
    }
  }, []);
  useIntervalPolling(refresh, REFRESH_MS);

  // Out-of-the-box, point the URL fields at the reserved monitored feed until
  // the operator types another name.
  useEffect(() => {
    if (streamName === '' && profiles.includes(INGEST_RESERVED_LABEL)) {
      setStreamName(INGEST_RESERVED_LABEL);
    }
  }, [profiles, streamName]);

  useEffect(() => {
    setHost(window.location.hostname);
    // The IRL Source option needs the obs-irl-source plugin loaded in OBS. If
    // the status endpoint is unavailable (older backend) keep the option on.
    // Not polled: it scans plugin status and the plugin rarely changes.
    getIrlSourceStatus()
      .then((s) => setIrlAvailable(s.loaded))
      .catch(() => setIrlAvailable(true));
  }, []);

  useEffect(
    () => () => {
      if (confirmTimer.current) clearTimeout(confirmTimer.current);
    },
    [],
  );

  const key = keyState.info?.key;

  const named = streamName.trim();
  const isSavedProfile = named !== '' && profiles.includes(named);
  const active = keyState.status === 'ok' && !!key && isSavedProfile;

  const urls = useMemo(
    () =>
      host && key ? generateIngestUrls(host, key, streamName.trim()) : null,
    [host, key, streamName],
  );

  const liveU = useMemo(
    () => (host && key ? generateLiveUDetails(host, key, named) : null),
    [host, key, named],
  );

  const srtla = useMemo(
    () => (host && key ? generateSrtlaDetails(host, key, named) : null),
    [host, key, named],
  );

  const provisionObs = useCallback(
    async (label: string, currentKey: string) => {
      try {
        await provisionObsMediaSource(
          label,
          generateObsReadUrl(host, currentKey, label),
        );
        setProvision({
          status: 'ok',
          message:
            'Provisioned in OBS as IRL Source (main scene) — show the QR to connect',
        });
      } catch (e) {
        const detail = e instanceof Error && e.message ? `: ${e.message}` : '';
        setProvision({
          status: 'error',
          message: `Profile saved — OBS provisioning failed${detail}, re-save to retry`,
        });
      }
    },
    [host],
  );

  const handleSaveProfile = async () => {
    const name = streamName.trim();
    if (!name || !key) return;
    const next = profiles.includes(name)
      ? profiles
      : [...profiles, name].sort();
    try {
      const state = await saveIngestProfiles(next, main);
      setProfiles(state.profiles);
      setMain(state.main);
    } catch (e) {
      setProvision({
        status: 'error',
        message: e instanceof Error ? e.message : 'Failed to save profile',
      });
      return;
    }
    await provisionObs(name, key);
  };

  const handleSetMain = async (name: string) => {
    if (name === main) return;
    try {
      const state = await saveIngestProfiles(profiles, name);
      setProfiles(state.profiles);
      setMain(state.main);
    } catch (e) {
      setProvision({
        status: 'error',
        message: e instanceof Error ? e.message : 'Failed to set monitored feed',
      });
    }
  };

  const handleLoadProfile = (name: string) => {
    setStreamName(name);
    setConfirmDelete(null);
    document
      .getElementById('streamKey')
      ?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  };

  const handleConfirmDelete = async (name: string) => {
    if (confirmDelete === name) {
      if (confirmTimer.current) clearTimeout(confirmTimer.current);
      confirmTimer.current = null;
      setConfirmDelete(null);
      await deleteObsMediaSource(name).catch(() => {});
      handleDeleteProfile(name);
      return;
    }
    setConfirmDelete(name);
    confirmTimer.current = setTimeout(() => setConfirmDelete(null), 4000);
  };

  const handleDeleteProfile = async (name: string) => {
    const next = profiles.filter((p) => p !== name);
    try {
      const state = await saveIngestProfiles(next, main);
      setProfiles(state.profiles);
      setMain(state.main);
    } catch {
      // Server state wins on the next poll; drop the optimistic list.
      setProfiles(next);
    }
  };

  const openApp = (encoder: Encoder) => {
    if (!active || !key) return;
    window.location.href = generateDeepLink(host, encoder, key, named);
  };

  const qrValue = (encoder: Encoder) =>
    active && key ? generateDeepLink(host, encoder, key, named) : '';

  return (
    <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
      <div className="lg:col-span-2 space-y-6">
        <div className="flex items-end gap-3">
          <div className="flex-1">
            <Field label="Stream Name" htmlFor="streamKey">
              <Input
                id="streamKey"
                placeholder="e.g. my_live_stream"
                value={streamName}
                onChange={(e) => setStreamName(e.target.value)}
              />
            </Field>
          </div>
          <Button
            onClick={handleSaveProfile}
            disabled={!key || !streamName.trim() || !irlAvailable}
          >
            Save Current
          </Button>
        </div>

        {!irlAvailable && (
          <p className="text-sm text-danger" role="alert">
            Ingest needs the obs-irl-source plugin, which isn&apos;t loaded in
            OBS — install it under Settings → OBS Plugins, then restart OBS.
          </p>
        )}

        {keyState.status === 'loading' && (
          <p className="text-xs text-text-secondary">Loading ingest URLs…</p>
        )}
        {keyState.status === 'error' && (
          <p className="text-sm text-danger" role="alert">
            {keyState.error}
          </p>
        )}

        {keyState.status === 'ok' && !active && (
          <div className="surface flex items-start gap-3 p-4 ring-1 ring-inset ring-warning/40">
            <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-warning-soft text-[11px] font-bold text-warning">
              !
            </span>
            <p className="text-xs text-text-secondary">
              {profiles.length === 0
                ? 'No profiles yet.'
                : named === ''
                  ? 'No profile selected.'
                  : `“${named}” isn’t saved yet.`}{' '}
              Type a{' '}
              <span className="font-semibold text-text-primary">
                Stream Name
              </span>{' '}
              and click{' '}
              <span className="font-semibold text-text-primary">
                Save Current
              </span>
              {profiles.length > 0 && ', or load a saved profile,'} to unlock
              these links.
            </p>
          </div>
        )}
      </div>

      <div className="lg:col-span-1 lg:row-span-2 space-y-6">
        <div className="surface h-fit p-5">
          <div className="flex items-center justify-between mb-3">
            <h3 className="text-sm font-semibold tracking-tight">
              Profiles
              {profiles.length > 0 && (
                <span className="ml-2 rounded-full bg-primary-soft px-2 py-0.5 text-[10px] font-semibold text-primary">
                  {profiles.length}
                </span>
              )}
            </h3>
          </div>
          <div className="space-y-2">
            {profiles.length === 0 && (
              <p className="text-xs text-text-secondary text-center py-4">
                No profiles saved yet.
              </p>
            )}
            {profiles.map((name) => (
              <div
                key={name}
                className="rounded-lg bg-bg-card p-3 ring-1 ring-inset ring-border-subtle"
              >
                <span className="mb-3 flex items-center gap-2 text-xs font-semibold">
                  <span className="truncate">{name}</span>
                  {name === main && <Badge tone="primary">Monitored</Badge>}
                  {name === INGEST_RESERVED_LABEL && (
                    <Badge>Reserved</Badge>
                  )}
                </span>
                <div className="flex gap-2">
                  <Button
                    size="sm"
                    variant="primary"
                    className="flex-1"
                    onClick={() => handleLoadProfile(name)}
                  >
                    Load
                  </Button>
                  <Button
                    size="sm"
                    variant={name === main ? 'secondary' : 'ghost'}
                    className={name === main ? 'flex-1' : 'flex-1'}
                    disabled={name === main}
                    onClick={() => handleSetMain(name)}
                  >
                    Monitor
                  </Button>
                  {name !== INGEST_RESERVED_LABEL && (
                    <Button
                      size="sm"
                      variant={confirmDelete === name ? 'danger' : 'ghost'}
                      className={
                        confirmDelete === name
                          ? 'flex-1 text-danger'
                          : 'flex-1 text-danger'
                      }
                      onClick={() => handleConfirmDelete(name)}
                    >
                      {confirmDelete === name ? 'Confirm?' : 'Delete'}
                    </Button>
                  )}
                </div>
              </div>
            ))}
          </div>
          {provision.status !== 'idle' && (
            <p
              className={`text-[13px] mt-3 ${provision.status === 'ok' ? 'text-success' : 'text-danger'}`}
            >
              {provision.message}
            </p>
          )}
        </div>
      </div>

      <div className="lg:col-span-2 space-y-6">
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4 items-start">
          <ProtocolCard
            id="str-rtmp"
            label="RTMP"
            tone="success"
            hint="LiveU / OBS"
            value={urls?.rtmp ?? ''}
            disabled={!active}
          />
          <ProtocolCard
            id="str-srt"
            label="SRT"
            tone="primary"
            hint="IRL Pro"
            value={urls?.srt ?? ''}
            disabled={!active}
          />
          <ProtocolCard
            id="str-srt-liveu"
            label="SRT (LiveU)"
            tone="warning"
            hint="Solo / Solo Pro"
            value={urls?.srtLiveU ?? ''}
            disabled={!active}
            details={
              liveU
                ? [
                    { label: 'Destination name', value: liveU.destination },
                    {
                      label: 'Primary Ingress URL',
                      value: liveU.primaryIngress,
                      secret: true,
                    },
                    {
                      label: 'Stream Name / Key',
                      value: liveU.streamId,
                      secret: true,
                    },
                  ]
                : undefined
            }
          />
          <ProtocolCard
            id="str-srtla"
            label="SRTLA"
            tone="danger"
            hint="BelaBox"
            value={urls?.srtla ?? ''}
            disabled={!active}
            details={
              srtla
                ? [
                    { label: 'SRTLA server address', value: srtla.serverAddress, secret: true },
                    { label: 'SRTLA port', value: srtla.port },
                    { label: 'SRT streamid', value: srtla.streamId, secret: true },
                  ]
                : undefined
            }
          />
        </div>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
          <EncoderPanel
            encoder="irlpro"
            qrValue={qrValue('irlpro')}
            onOpen={() => openApp('irlpro')}
            disabled={!active}
          />
          <EncoderPanel
            encoder="moblin"
            qrValue={qrValue('moblin')}
            onOpen={() => openApp('moblin')}
            disabled={!active}
          />
          <EncoderPanel
            encoder="irlwhatever"
            qrValue={qrValue('irlwhatever')}
            onOpen={() => openApp('irlwhatever')}
            disabled={!active}
          />
        </div>
      </div>
    </div>
  );
}

interface EncoderPanelProps {
  encoder: Encoder;
  qrValue: string;
  onOpen: () => void;
  disabled?: boolean;
}

function EncoderPanel({
  encoder,
  qrValue,
  onOpen,
  disabled = false,
}: EncoderPanelProps) {
  const [open, setOpen] = useState(false);
  const label =
    encoder === 'irlpro'
      ? 'IRL Pro'
      : encoder === 'moblin'
        ? 'Moblin'
        : 'IRLwhatever';
  const storeUrl =
    encoder === 'irlpro'
      ? IRL_PRO_STORE_URL
      : encoder === 'moblin'
        ? MOBLIN_STORE_URL
        : IRLWHATEVER_STORE_URL;

  useEffect(() => {
    if (!qrValue) setOpen(false);
  }, [qrValue]);

  return (
    <div
      className={cn(
        'surface flex flex-col items-center p-6',
        disabled && 'opacity-60',
      )}
    >
      <div className="mb-4 rounded-full bg-primary-soft px-3 py-1 text-xs font-semibold tracking-wide text-primary">
        {label}
      </div>
      <div className="flex flex-wrap justify-center gap-2">
        <Button variant="secondary" onClick={() => setOpen(true)} disabled={disabled}>
          Show QR
        </Button>
        <Button onClick={onOpen} disabled={disabled}>
          Open in App
        </Button>
      </div>
      <a
        href={storeUrl}
        target="_blank"
        rel="noreferrer"
        className="mt-auto pt-4 inline-flex items-center gap-1.5 text-xs text-text-secondary whitespace-nowrap hover:text-primary transition-colors"
      >
        Download on {encoder === 'moblin' ? 'the App Store' : 'Google Play'}
        <svg
          aria-hidden="true"
          className="h-3.5 w-3.5"
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
        >
          <path
            stroke-linecap="round"
            stroke-linejoin="round"
            stroke-width="2"
            d="M4.5 19.5l15-15m0 0H8.25m11.25 0v11.25"
          />
        </svg>
      </a>

      {open && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4"
          onClick={() => setOpen(false)}
          data-testid={`qr-modal-${encoder}`}
        >
          <div
            className="flex flex-col items-center gap-3 rounded-card bg-bg-card p-6 shadow-2xl ring-1 ring-inset ring-border-subtle"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex w-full items-center justify-between gap-3">
              <p className="text-sm font-semibold tracking-tight text-text-primary">
                Scan with {label}
              </p>
              <button
                type="button"
                aria-label="Close QR"
                onClick={() => setOpen(false)}
                className="inline-flex h-8 w-8 items-center justify-center rounded-lg text-text-faint transition-colors hover:bg-bg-elevated hover:text-text-primary"
              >
                <svg
                  aria-hidden="true"
                  className="h-4 w-4"
                  fill="none"
                  viewBox="0 0 24 24"
                  stroke="currentColor"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth="1.75"
                    d="M6 18L18 6M6 6l12 12"
                  />
                </svg>
              </button>
            </div>
            {qrValue ? (
              <div className="rounded-xl bg-white p-4">
                <QRCodeSVG value={qrValue} size={340} />
              </div>
            ) : (
              <p className="text-xs text-neutral-500 px-8 pb-4">
                Save or load a profile to enable the QR code.
              </p>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
