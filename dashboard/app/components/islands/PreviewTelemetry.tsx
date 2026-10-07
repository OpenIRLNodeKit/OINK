"use client";
// SPDX-FileCopyrightText: 2026 OpenIRLNodeKit contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import {
  formatResolution,
  useObsStreamSettings,
} from '../../lib/useObsStreamSettings';

function TelemetryItem({
  label,
  value,
}: {
  label: string;
  value: React.ReactNode;
}) {
  return (
    <div className="flex items-center gap-2">
      <span className="text-xs font-medium uppercase tracking-[0.12em] text-text-faint">
        {label}
      </span>
      <span className="text-sm text-text-primary tabular">{value}</span>
    </div>
  );
}

export default function PreviewTelemetry({
  bitrate = null,
}: {
  bitrate?: number | null;
}) {
  const { settings, lastUpdated, loading } = useObsStreamSettings();

  const resolution = formatResolution(settings);

  return (
    <div className="mt-3 flex flex-wrap items-center gap-x-6 gap-y-2 border-t border-border-subtle pt-3">
      <TelemetryItem
        label="Resolution"
        value={
          <span
            className={resolution ? undefined : 'text-text-secondary'}
            title={resolution ? undefined : 'Requires OBS connection'}
          >
            {resolution ?? (loading ? '…' : '—')}
          </span>
        }
      />
      <TelemetryItem
        label="Bitrate"
        value={
          <span className={bitrate === null ? 'text-text-secondary' : undefined}>
            {bitrate === null ? '—' : `${bitrate} kbps`}
          </span>
        }
      />
      {lastUpdated && (
        <TelemetryItem label="Last Check" value={lastUpdated.toLocaleTimeString()} />
      )}
    </div>
  );
}
