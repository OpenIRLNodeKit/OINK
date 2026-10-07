'use client';
// SPDX-FileCopyrightText: 2026 OpenIRLNodeKit contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import type { IngestSeries, StatusSample } from '../../lib/useStatusUpdate';

interface IngestStatsChartProps {
  series: IngestSeries | null;
  low: number | null;
  offline: number | null;
  connected: boolean;
}

// Values are plotted in a 0..100 square that is stretched to the container
// (preserveAspectRatio="none"); stroke widths use vector-effect so they stay
// crisp, and all text is HTML overlay (never distorted by the scaling).
const UNIT = 100;

// Y-axis ceiling: bitrate, both NOALBS thresholds, and a 1000 kbps floor so an
// idle ingest does not render as a meaningless flat line pinned to the top.
export function chartCeiling(
  history: StatusSample[],
  low: number | null,
  offline: number | null,
): number {
  let max = 1000;
  for (const sample of history) max = Math.max(max, sample.bitrate);
  max = Math.max(max, low ?? 0, offline ?? 0);
  return Math.ceil((max * 1.1) / 100) * 100;
}

export function chartPoints(
  history: StatusSample[],
  ceiling: number,
): { x: number; y: number }[] {
  const n = history.length;
  if (n === 0 || ceiling <= 0) return [];
  return history.map((sample, i) => ({
    x: n === 1 ? UNIT : (i / (n - 1)) * UNIT,
    y: UNIT - (Math.min(sample.bitrate, ceiling) / ceiling) * UNIT,
  }));
}

export function linePath(points: { x: number; y: number }[]): string {
  return points
    .map((p, i) => `${i === 0 ? 'M' : 'L'}${p.x.toFixed(2)},${p.y.toFixed(2)}`)
    .join(' ');
}

export function areaPath(points: { x: number; y: number }[]): string {
  if (points.length === 0) return '';
  const last = points[points.length - 1];
  return `${linePath(points)} L${last.x.toFixed(2)},${UNIT} L${points[0].x.toFixed(2)},${UNIT} Z`;
}

function thresholdY(value: number, ceiling: number): number {
  return UNIT - (Math.min(value, ceiling) / ceiling) * UNIT;
}

export default function IngestStatsChart({
  series,
  low,
  offline,
  connected,
}: IngestStatsChartProps) {
  const history = series?.history ?? [];
  const ceiling = chartCeiling(history, low, offline);
  const points = chartPoints(history, ceiling);
  const bitrate = series?.bitrate ?? null;
  const isOffline = series !== null && series.ready === false;

  return (
    <div>
      <div className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
        <p className="flex items-baseline gap-2 text-2xl font-semibold tracking-tight tabular">
          {bitrate === null ? '—' : `${bitrate} kbps`}
          {series && (
            <span className="text-sm font-normal text-text-faint">
              {series.id}
            </span>
          )}
        </p>
        <div className="flex items-center gap-3 text-xs text-text-faint">
          {low != null && (
            <span className="flex items-center gap-1.5">
              <span className="inline-block h-px w-4 border-t border-dashed border-warning" />
              low {low}
            </span>
          )}
          {offline != null && (
            <span className="flex items-center gap-1.5">
              <span className="inline-block h-px w-4 border-t border-dashed border-danger" />
              offline {offline}
            </span>
          )}
          <span className="uppercase tracking-[0.12em]">5 min</span>
        </div>
      </div>

      <div className="relative h-48 overflow-hidden rounded-lg border border-border-subtle bg-bg-dark">
        {points.length < 2 ? (
          <div className="flex h-full items-center justify-center px-4 text-center text-sm text-text-faint">
            {!connected
              ? 'Connecting to status feed…'
              : !series
                ? 'No ingests detected'
                : isOffline
                  ? 'Ingest offline'
                  : 'Waiting for ingest…'}
          </div>
        ) : (
          <>
            <svg
              className="absolute inset-0 h-full w-full"
              viewBox={`0 0 ${UNIT} ${UNIT}`}
              preserveAspectRatio="none"
              aria-hidden="true"
            >
              {low != null && (
                <line
                  x1="0"
                  x2={UNIT}
                  y1={thresholdY(low, ceiling)}
                  y2={thresholdY(low, ceiling)}
                  stroke="var(--color-warning)"
                  strokeWidth="1"
                  strokeDasharray="4 4"
                  vectorEffect="non-scaling-stroke"
                />
              )}
              {offline != null && (
                <line
                  x1="0"
                  x2={UNIT}
                  y1={thresholdY(offline, ceiling)}
                  y2={thresholdY(offline, ceiling)}
                  stroke="var(--color-danger)"
                  strokeWidth="1"
                  strokeDasharray="4 4"
                  vectorEffect="non-scaling-stroke"
                />
              )}
              <path
                d={areaPath(points)}
                fill="var(--color-primary)"
                fillOpacity="0.15"
              />
              <path
                d={linePath(points)}
                fill="none"
                stroke="var(--color-primary)"
                strokeWidth="2"
                strokeLinejoin="round"
                strokeLinecap="round"
                vectorEffect="non-scaling-stroke"
              />
            </svg>
            <span className="pointer-events-none absolute top-1.5 right-2 text-[11px] text-text-faint tabular">
              {ceiling} kbps
            </span>
            {isOffline && (
              <span className="pointer-events-none absolute bottom-2 left-2 rounded-full bg-bg-elevated/80 px-2 py-0.5 text-[11px] font-medium text-text-secondary">
                Ingest offline
              </span>
            )}
          </>
        )}
      </div>
    </div>
  );
}
