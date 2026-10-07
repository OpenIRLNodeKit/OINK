"use client";
// SPDX-FileCopyrightText: 2026 OpenIRLNodeKit contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  getDefaultPluginStatus,
  installDefaultPlugin,
  restartObs,
  uploadObsPlugin,
  type DefaultPluginStatus,
} from '../../lib/api';
import { Button, Card } from '../ui';

type Busy = null | string;

interface Notice {
  tone: 'ok' | 'error';
  text: string;
}

export default function ObsPluginsCard() {
  const [plugins, setPlugins] = useState<DefaultPluginStatus[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<Busy>(null);
  const [restartPending, setRestartPending] = useState(false);
  const [notice, setNotice] = useState<Notice | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const refresh = useCallback(async () => {
    try {
      setPlugins(await getDefaultPluginStatus());
    } catch (e) {
      setNotice({
        tone: 'error',
        text: e instanceof Error ? e.message : 'Failed to load plugin status',
      });
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const run = async (
    busyKind: string,
    fn: () => Promise<unknown>,
    okText: string,
  ) => {
    setBusy(busyKind);
    setNotice(null);
    try {
      await fn();
      setNotice({ tone: 'ok', text: okText });
      setRestartPending(true);
      await refresh();
    } catch (e) {
      setNotice({
        tone: 'error',
        text: e instanceof Error ? e.message : 'Operation failed',
      });
    } finally {
      setBusy(null);
    }
  };

  const handleInstall = (name: string) => {
    void run(
      `install:${name}`,
      () => installDefaultPlugin(name),
      `${name} installed`,
    );
  };

  const handleRestart = async () => {
    setBusy('restarting');
    setNotice(null);
    try {
      await restartObs();
      setNotice({ tone: 'ok', text: 'OBS restarted' });
      setRestartPending(false);
      await refresh();
    } catch (e) {
      setNotice({
        tone: 'error',
        text: e instanceof Error ? e.message : 'Failed to restart OBS',
      });
    } finally {
      setBusy(null);
    }
  };

  const handleUpload = async (file: File | null) => {
    if (!file) return;
    try {
      await run(
        'uploading',
        () => uploadObsPlugin(file),
        `Plugin "${file.name}" installed`,
      );
    } finally {
      if (fileRef.current) fileRef.current.value = '';
    }
  };

  const installedPill = (installed: boolean) =>
    `rounded-full px-2 py-0.5 font-semibold ${installed ? 'bg-success/15 text-success' : 'bg-bg-elevated text-text-secondary'}`;

  const loadedPill = (loaded: boolean) =>
    `rounded-full px-2 py-0.5 font-semibold ${loaded ? 'bg-success/15 text-success' : 'bg-warning/15 text-warning'}`;

  return (
    <Card
      title="OBS Plugins"
      description="Default plugins shipped with the build (cannot be removed) + uploads for third-party drop-ins."
    >
      <div className="space-y-4 p-5">
        {loading ? (
          <p className="text-xs text-text-secondary">Loading plugin status…</p>
        ) : (
          <ul className="space-y-3">
            {(plugins ?? []).map((p) => (
              <li
                key={p.name}
                className="flex flex-wrap items-center gap-2 text-xs"
              >
                <span className="font-semibold text-text-primary">
                  {p.name} {p.version}
                </span>
                <span
                  className="rounded-full bg-bg-elevated px-2 py-0.5 font-semibold text-text-secondary"
                  title="Part of the build — installed by 'oink.py setup' and cannot be removed"
                >
                  default
                </span>
                <span className={installedPill(p.installed)}>
                  {p.installed ? 'installed' : 'not installed'}
                </span>
                <span className={loadedPill(p.loaded)}>
                  {p.loaded
                    ? 'loaded in OBS'
                    : p.installed
                      ? p.name === 'obs-irl-source'
                        ? 'not loaded — restart OBS'
                        : 'installed — restart OBS to apply'
                      : '—'}
                </span>
                {!p.installed && (
                  <Button
                    variant="primary"
                    size="sm"
                    disabled={busy !== null}
                    onClick={() => handleInstall(p.name)}
                  >
                    {busy === `install:${p.name}` ? 'Installing…' : 'Install'}
                  </Button>
                )}
              </li>
            ))}
          </ul>
        )}

        <div className="flex flex-wrap gap-2">
          <label className="inline-flex cursor-pointer items-center gap-2">
            <input
              ref={fileRef}
              type="file"
              accept=".tar.gz,.tgz,.tar.xz,.tar.bz2,.tar"
              className="hidden"
              disabled={busy !== null}
              onChange={(e) => void handleUpload(e.target.files?.[0] ?? null)}
            />
            <span className="inline-flex select-none items-center justify-center gap-2 rounded-control bg-bg-card px-4 py-2 text-sm font-medium text-text-primary ring-1 ring-inset ring-border-subtle transition-colors hover:bg-bg-elevated hover:ring-border disabled:opacity-50">
              {busy === 'uploading' ? 'Uploading…' : 'Upload plugin tarball'}
            </span>
          </label>
        </div>

        {restartPending && (
          <div className="flex flex-wrap items-center gap-3 rounded-lg bg-warning/10 p-3 ring-1 ring-inset ring-warning/30">
            <p className="text-[13px] text-text-primary">
              Restart OBS to load/unload the change? This drops the live ingest
              for a few seconds.
            </p>
            <div className="flex gap-2">
              <Button
                size="sm"
                variant="warning"
                disabled={busy !== null}
                onClick={handleRestart}
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

        {notice && (
          <p
            role="status"
            className={`text-[13px] ${notice.tone === 'ok' ? 'text-success' : 'text-danger'}`}
          >
            {notice.text}
          </p>
        )}
      </div>
    </Card>
  );
}
