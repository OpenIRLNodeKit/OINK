"use client";
// SPDX-FileCopyrightText: 2026 OpenIRLNodeKit contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useEffect, useState } from 'react';
import { getVersions, logsDownloadUrl, type VersionsInfo } from '../../lib/api';
import { useHasRole } from '../../lib/auth-context';
import { Button } from '../ui';

function rows(v: VersionsInfo): { label: string; value: string }[] {
  const val = (x: string | null) => x || 'unknown';
  return [
    { label: 'OINK', value: v.oink || 'unknown' },
    { label: 'OBS Studio', value: val(v.obs) },
    { label: 'obs-websocket', value: val(v.obsWebSocket) },
    { label: 'MediaMTX', value: val(v.mediamtx) },
    { label: 'NOALBS', value: val(v.noalbs) },
    ...v.plugins.map((p) => ({
      label: p.name,
      value: `${p.version}${p.installed ? '' : ' (not installed)'}`,
    })),
    { label: 'Node.js', value: v.node || 'unknown' },
    { label: 'OS', value: `${v.os} ${v.arch}`.trim() || 'unknown' },
  ];
}

export default function VersionsPanel() {
  const [versions, setVersions] = useState<VersionsInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const canOperate = useHasRole(['admin', 'operator']);

  useEffect(() => {
    let alive = true;
    getVersions()
      .then((v) => {
        if (alive) setVersions(v);
      })
      .catch((e) => {
        if (alive) setError(e instanceof Error ? e.message : 'Failed to load versions');
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, []);

  const handleCopy = async () => {
    if (!versions) return;
    const text = rows(versions)
      .map((r) => `${r.label}: ${r.value}`)
      .join('\n');
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      setError('Copy failed — select the table manually');
    }
  };

  return (
    <div className="surface overflow-hidden">
      <div className="flex items-center justify-between gap-3 border-b border-border-subtle px-5 py-3.5">
        <div className="flex items-baseline gap-3">
          <h3 className="text-sm font-medium tracking-tight">Versions</h3>
          <span className="text-xs text-text-secondary">
            Include this when filing a GitHub issue
          </span>
        </div>
        <Button
          size="sm"
          variant="ghost"
          disabled={!versions}
          onClick={() => void handleCopy()}
        >
          {copied ? 'Copied' : 'Copy'}
        </Button>
      </div>
      <div className="p-5">
        {loading && <p className="text-xs text-text-secondary">Loading versions…</p>}
        {error && (
          <p role="alert" className="text-xs text-danger">
            {error}
          </p>
        )}
        {versions && (
          <table className="w-full text-left text-xs">
            <tbody>
              {rows(versions).map((r) => (
                <tr
                  key={r.label}
                  className="border-b border-border-subtle last:border-0"
                >
                  <td className="py-1.5 pr-4 font-medium text-text-secondary">
                    {r.label}
                  </td>
                  <td className="py-1.5 tabular text-text-primary">{r.value}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {canOperate && (
          <div className="mt-4">
            <a
              href={logsDownloadUrl()}
              className="inline-flex select-none items-center justify-center gap-2 rounded-control bg-bg-card px-4 py-2 text-sm font-medium text-text-primary ring-1 ring-inset ring-border-subtle transition-colors hover:bg-bg-elevated hover:ring-border"
            >
              Download all logs (.zip)
            </a>
          </div>
        )}
      </div>
    </div>
  );
}
