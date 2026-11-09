"use client";
// SPDX-FileCopyrightText: 2026 OpenIRLNodeKit contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useEffect, useState } from 'react';
import { Link } from 'react-router';
import { getDiskUsage, type DiskInfo } from '../../lib/api';
import { formatBytes } from '../../lib/format';

const WARN_PERCENT = 80;
const POLL_MS = 60_000;

export default function DiskWarningBanner() {
  const [disks, setDisks] = useState<DiskInfo[] | null>(null);

  useEffect(() => {
    let live = true;
    const load = async () => {
      try {
        const rows = await getDiskUsage();
        if (live) setDisks(rows);
      } catch {
        if (live) setDisks(null); // A monitoring failure must not scare the operator.
      }
    };
    void load();
    const id = setInterval(load, POLL_MS);
    return () => {
      live = false;
      clearInterval(id);
    };
  }, []);

  const full = (disks ?? []).filter((d) => d.percent >= WARN_PERCENT);
  if (full.length === 0) return null;

  const danger = full.some((d) => d.percent >= 90);
  const labels = full.map((d) => d.label).join(', ');
  const percent = Math.max(...full.map((d) => d.percent));
  const free = Math.min(...full.map((d) => d.free));

  return (
    <div
      role="alert"
      className={`flex flex-wrap items-center justify-between gap-3 border-b px-4 py-2.5 text-[13px] sm:px-6 ${
        danger
          ? 'border-danger/30 bg-danger-soft text-danger'
          : 'border-warning/30 bg-warning-soft text-warning'
      }`}
    >
      <p>
        <span className="font-semibold">Low disk space</span> — {labels}{' '}
        {percent}% used, {formatBytes(free)} free. Recordings or uploads may fail.
      </p>
      <Link to="/settings" className="font-medium underline underline-offset-2">
        View disk usage
      </Link>
    </div>
  );
}
