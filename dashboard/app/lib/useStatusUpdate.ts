// SPDX-FileCopyrightText: 2026 OpenIRLNodeKit contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
import { useCallback, useState } from 'react';
import { useWebSocket } from './useWebSocket';

// Controller status feed (/api/ws): one OpenIRLNodeKitStatusUpdate packet every
// 2.5s, carrying every ingest feed under this install's keyed namespace. We keep
// a rolling bitrate window per feed so the dashboard can chart each one.
export const STATUS_MAX_SAMPLES = 120; // 5 min @ 2.5s

export interface StatusSample {
  t: number;
  bitrate: number;
}

export interface IngestSeries {
  id: string;
  ready: boolean;
  bitrate: number;
  history: StatusSample[];
}

interface StatusLatest {
  scene: string | null;
  low: number | null;
  offline: number | null;
}

export interface StatusPacket {
  feeds: {
    id: string;
    ready: boolean;
    bitrate: number;
  }[];
  mainIngestId: string | null;
  scene: string | null;
  low: number | null;
  offline: number | null;
}

interface UseStatusUpdateResult {
  connected: boolean;
  ingests: IngestSeries[];
  latest: StatusLatest | null;
  mainIngestId: string | null;
}

function finiteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

// Append to a fixed-size window: drop the oldest sample once at capacity.
export function pushSample<T>(
  history: T[],
  sample: T,
  max = STATUS_MAX_SAMPLES,
): T[] {
  const next =
    history.length >= max
      ? history.slice(history.length - max + 1)
      : history.slice();
  next.push(sample);
  return next;
}

// Validate + flatten one status packet. Returns null for anything that isn't a
// status update, so malformed/foreign frames are ignored.
export function parseStatusMessage(raw: unknown): StatusPacket | null {
  if (!raw || typeof raw !== 'object') return null;
  const msg = raw as Record<string, unknown>;
  if (msg.type !== 'OpenIRLNodeKitStatusUpdate') return null;

  const feeds = (Array.isArray(msg.ingests) ? msg.ingests : [])
    .filter(
      (i): i is Record<string, unknown> => Boolean(i) && typeof i === 'object',
    )
    .map((i) => ({
      id: typeof i.id === 'string' ? i.id : '',
      ready: i.media_state === 'OBS_MEDIA_STATE_PLAYING',
      bitrate: finiteNumber(i.router_bitrate) ?? 0,
    }))
    .filter((f) => f.id !== '');

  return {
    feeds,
    mainIngestId:
      typeof msg.main_ingest_id === 'string' ? msg.main_ingest_id : null,
    scene: typeof msg.scene === 'string' ? msg.scene : null,
    low: finiteNumber(msg.low_bitrate_trigger),
    offline: finiteNumber(msg.offline_bitrate_trigger),
  };
}

// Fold a packet into the known series: append samples for present feeds, and
// keep feeds that vanished this tick (marked offline) so their graph is still
// reviewable for the rest of the session.
export function mergeIngests(
  prev: IngestSeries[],
  packet: StatusPacket,
  now: number,
): IngestSeries[] {
  const byId = new Map(prev.map((s) => [s.id, s]));
  const present = new Set<string>();
  for (const feed of packet.feeds) {
    present.add(feed.id);
    const existing = byId.get(feed.id);
    byId.set(feed.id, {
      id: feed.id,
      ready: feed.ready,
      bitrate: feed.bitrate,
      history: pushSample(existing?.history ?? [], {
        t: now,
        bitrate: feed.bitrate,
      }),
    });
  }
  for (const [id, series] of byId) {
    if (!present.has(id)) byId.set(id, { ...series, ready: false, bitrate: 0 });
  }
  return [...byId.values()];
}

// Display list for the dashboard: every saved profile (offline placeholder if
// it has never published this session) plus any live feed that isn't a profile.
// The canonical `stream` path is infrastructure, so it only shows once it has
// actually carried data (or if the operator saved it as a profile).
export function mergeFeedList(
  live: IngestSeries[],
  profiles: string[],
): IngestSeries[] {
  const byId = new Map(live.map((s) => [s.id, s]));
  for (const name of profiles) {
    if (!byId.has(name)) {
      byId.set(name, { id: name, ready: false, bitrate: 0, history: [] });
    }
  }
  const saved = new Set(profiles);
  return [...byId.values()].filter(
    (s) =>
      s.id !== 'irl' ||
      s.ready ||
      s.history.some((sample) => sample.bitrate > 0) ||
      saved.has(s.id),
  );
}

export function useStatusUpdate(): UseStatusUpdateResult {
  const [ingests, setIngests] = useState<IngestSeries[]>([]);
  const [latest, setLatest] = useState<StatusLatest | null>(null);
  const [mainIngestId, setMainIngestId] = useState<string | null>(null);

  const onMessage = useCallback((raw: unknown) => {
    const packet = parseStatusMessage(raw);
    if (!packet) return;
    setLatest({
      scene: packet.scene,
      low: packet.low,
      offline: packet.offline,
    });
    setMainIngestId(packet.mainIngestId);
    setIngests((prev) => mergeIngests(prev, packet, Date.now()));
  }, []);

  const { status } = useWebSocket<unknown>('/api/ws', { onMessage });

  return { connected: status === 'connected', ingests, latest, mainIngestId };
}
