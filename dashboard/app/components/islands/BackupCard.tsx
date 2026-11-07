"use client";
// SPDX-FileCopyrightText: 2026 OpenIRLNodeKit contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useEffect, useRef, useState } from 'react';
import { backupDownloadUrl, getBackupSize, restoreBackup } from '../../lib/api';
import { useChannel } from '../../lib/useChannel';
import { Card } from '../ui';

type Notice = { tone: 'ok' | 'error'; text: string } | null;

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i += 1;
  }
  return `${v.toFixed(v >= 10 ? 0 : 1)} ${units[i]}`;
}

export default function BackupCard() {
  const [assets, setAssets] = useState(false);
  const [recordings, setRecordings] = useState(false);
  const [size, setSize] = useState<{ files: number; bytes: number } | null>(
    null,
  );
  const [busy, setBusy] = useState(false);
  const { channel } = useChannel();
  const [notice, setNotice] = useState<Notice>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    let live = true;
    getBackupSize(assets, recordings)
      .then((s) => {
        if (live) setSize(s);
      })
      .catch(() => {
        if (live) setSize(null);
      });
    return () => {
      live = false;
    };
  }, [assets, recordings]);

  const handleRestore = async (file: File | null) => {
    if (!file) return;
    const ok = window.confirm(
      'Restore this backup over the current state? Affected services restart and a live stream may drop.',
    );
    if (!ok) {
      if (fileRef.current) fileRef.current.value = '';
      return;
    }
    setBusy(true);
    setNotice(null);
    try {
      const r = await restoreBackup(file);
      const bits = [`${r.restored.length} files restored`];
      if (r.failed.length) bits.push(`${r.failed.length} failed`);
      if (r.restarted.length) bits.push(`restarted ${r.restarted.join(', ')}`);
      if (r.skipped.length) bits.push(`skipped ${r.skipped.join(', ')}`);
      setNotice({
        tone: r.failed.length ? 'error' : 'ok',
        text: bits.join(' · ') + (r.note ? ` — ${r.note}` : ''),
      });
    } catch (e) {
      setNotice({
        tone: 'error',
        text: e instanceof Error ? e.message : 'Restore failed',
      });
    } finally {
      setBusy(false);
      if (fileRef.current) fileRef.current.value = '';
    }
  };

  const buttonClass =
    'inline-flex select-none items-center justify-center gap-2 rounded-control bg-bg-card px-4 py-2 text-sm font-medium text-text-primary ring-1 ring-inset ring-border-subtle transition-colors hover:bg-bg-elevated hover:ring-border';

  return (
    <Card
      title="Backup & Restore"
      description="Download box state (stream key, NOALBS, OBS scenes/profiles) or restore an archive. Dashboard accounts are never included."
    >
      <div className="space-y-4 p-5">
        <div className="space-y-2">
          <label className="flex items-center gap-2 text-[13px] text-text-primary">
            <input
              type="checkbox"
              checked={assets}
              onChange={(e) => setAssets(e.target.checked)}
            />
            Include uploaded assets
          </label>
          <label className="flex items-center gap-2 text-[13px] text-text-primary">
            <input
              type="checkbox"
              checked={recordings}
              onChange={(e) => setRecordings(e.target.checked)}
            />
            Include recordings
          </label>
          {size && (
            <p className="text-xs text-text-secondary">
              {size.files} files · {formatBytes(size.bytes)}
            </p>
          )}
        </div>

        <div className="flex flex-wrap gap-2">
          <a
            href={backupDownloadUrl(assets, recordings, channel)}
            className={buttonClass}
          >
            Download backup
          </a>
          <label className="inline-flex cursor-pointer">
            <input
              ref={fileRef}
              type="file"
              accept=".zip,.enc"
              className="hidden"
              disabled={busy}
              onChange={(e) => void handleRestore(e.target.files?.[0] ?? null)}
            />
            <span className={`${buttonClass} ${busy ? 'opacity-50' : ''}`}>
              {busy ? 'Restoring…' : 'Restore from file'}
            </span>
          </label>
        </div>

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
