// SPDX-FileCopyrightText: 2026 OpenIRLNodeKit contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { IngestSeries } from '../../lib/useStatusUpdate';
import IngestStatsChart, {
  areaPath,
  chartCeiling,
  chartPoints,
  linePath,
} from './IngestStatsChart';

const series: IngestSeries = {
  id: 'test',
  ready: true,
  bitrate: 4200,
  history: [
    { t: 0, bitrate: 1000 },
    { t: 2500, bitrate: 4200 },
  ],
};

describe('IngestStatsChart geometry', () => {
  it('sets the ceiling above bitrate and thresholds with headroom', () => {
    expect(chartCeiling(series.history, 900, 300)).toBe(4700);
    expect(chartCeiling([], null, null)).toBe(1100);
  });

  it('maps samples into the 0..100 unit square', () => {
    expect(
      chartPoints(
        [
          { t: 0, bitrate: 0 },
          { t: 1, bitrate: 500 },
        ],
        1000,
      ),
    ).toEqual([
      { x: 0, y: 100 },
      { x: 100, y: 50 },
    ]);
  });

  it('builds line and closed area paths', () => {
    const points = chartPoints(
      [
        { t: 0, bitrate: 0 },
        { t: 1, bitrate: 500 },
      ],
      1000,
    );
    expect(linePath(points)).toBe('M0.00,100.00 L100.00,50.00');
    expect(areaPath(points)).toBe(
      'M0.00,100.00 L100.00,50.00 L100.00,100 L0.00,100 Z',
    );
  });
});

describe('IngestStatsChart', () => {
  it('renders the selected feed with thresholds and a trace', () => {
    const { container } = render(
      <IngestStatsChart series={series} low={900} offline={300} connected />,
    );
    expect(screen.getByText('4200 kbps')).toBeInTheDocument();
    expect(screen.getByText('test')).toBeInTheDocument();
    expect(screen.getByText('low 900')).toBeInTheDocument();
    expect(screen.getByText('offline 300')).toBeInTheDocument();
    expect(container.querySelectorAll('path')).toHaveLength(2);
  });

  it('marks an idle feed offline', () => {
    render(
      <IngestStatsChart
        series={{ ...series, ready: false, bitrate: 0 }}
        low={900}
        offline={300}
        connected
      />,
    );
    expect(screen.getAllByText('Ingest offline').length).toBeGreaterThan(0);
  });

  it('shows connecting and no-ingest states', () => {
    const { rerender } = render(
      <IngestStatsChart
        series={null}
        low={null}
        offline={null}
        connected={false}
      />,
    );
    expect(screen.getByText('Connecting to status feed…')).toBeInTheDocument();
    rerender(
      <IngestStatsChart series={null} low={null} offline={null} connected />,
    );
    expect(screen.getByText('No ingests detected')).toBeInTheDocument();
  });
});
