"use client";
// SPDX-FileCopyrightText: 2026 OpenIRLNodeKit contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useCallback, useEffect, useState } from 'react';
import { getDiskUsage, type DiskInfo } from '../../lib/api';
import { formatBytes } from '../../lib/format';
import { Button, Card } from '../ui';

function barTone(percent: number): string {
  if (percent >= 90) return 'bg-danger';
  if (percent >= 80) return 'bg-warning';
  return 'bg-primary';
}

export default function DiskUsageCard() {
  const [disks, setDisks] = useState<DiskInfo[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      setDisks(await getDiskUsage());
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load disk usage');
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return (
    <Card
      title="Disk space"
      description="Filesystem usage on this server — assets, recordings, and system."
    >
      {error && (
        <p className="text-sm text-danger" role="alert">
          {error}
        </p>
      )}

      {!error && disks === null && (
        <p className="text-sm text-text-faint">Loading…</p>
      )}

      {!error && disks && disks.length === 0 && (
        <p className="text-sm text-text-faint">No filesystems reported yet.</p>
      )}

      {!error && disks && disks.length > 0 && (
        <div className="space-y-5">
          {disks.map((d) => (
            <div key={d.paths[0]}>
              <div className="flex items-baseline justify-between gap-4">
                <span className="text-sm font-medium text-text-primary">
                  {d.label}
                </span>
                <span className="text-[13px] text-text-secondary">
                  {d.percent}% · {formatBytes(d.free)} free
                </span>
              </div>
              <div
                className="mt-2 h-2 overflow-hidden rounded-full bg-bg-elevated"
                role="progressbar"
                aria-label={`${d.label} disk usage`}
                aria-valuenow={d.percent}
                aria-valuemin={0}
                aria-valuemax={100}
              >
                <div
                  className={`h-full rounded-full ${barTone(d.percent)}`}
                  style={{ width: `${Math.min(100, d.percent)}%` }}
                />
              </div>
              <p className="mt-1.5 text-[12px] text-text-faint">
                {formatBytes(d.used)} used of {formatBytes(d.total)}
              </p>
            </div>
          ))}
          <Button variant="ghost" size="sm" onClick={() => void refresh()}>
            Refresh
          </Button>
        </div>
      )}
    </Card>
  );
}
