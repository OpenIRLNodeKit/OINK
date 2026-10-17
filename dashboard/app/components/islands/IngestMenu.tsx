'use client';
// SPDX-FileCopyrightText: 2026 OpenIRLNodeKit contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useEffect, useRef, useState } from 'react';
import type { IngestControlState } from '../../lib/api';
import type { IngestSeries } from '../../lib/useStatusUpdate';
import { Badge, Button } from '../ui';

interface IngestMenuProps {
  ingests: IngestSeries[];
  selected: string | null;
  /** The feed NOALBS is currently monitoring (shown as a badge). */
  monitored?: string | null;
  onSelect: (id: string) => void;
  connected: boolean;
  controls: Record<string, IngestControlState>;
  pending: string | null;
  onToggleMute: (name: string) => void;
  onToggleVisibility: (name: string) => void;
  onRestart: (name: string) => void;
}

function sortIngests(ingests: IngestSeries[]): IngestSeries[] {
  return [...ingests].sort((a, b) => {
    if (a.ready !== b.ready) return a.ready ? -1 : 1;
    if (a.ready && b.ready && a.bitrate !== b.bitrate)
      return b.bitrate - a.bitrate;
    return a.id.localeCompare(b.id);
  });
}

function SpeakerIcon({ muted }: { muted: boolean }) {
  return (
    <svg
      className="h-4 w-4"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.7}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M4 9v6h3.5L12 19V5L7.5 9H4z" />
      {muted ? (
        <path d="M16 9.5l5 5M21 9.5l-5 5" />
      ) : (
        <>
          <path d="M15.5 9a4 4 0 010 6" />
          <path d="M18 6.5a7.5 7.5 0 010 11" />
        </>
      )}
    </svg>
  );
}

function EyeIcon({ hidden }: { hidden: boolean }) {
  return (
    <svg
      className="h-4 w-4"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.7}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z" />
      <circle cx="12" cy="12" r="2.75" />
      {hidden && <path d="M4 4l16 16" />}
    </svg>
  );
}

function FixIcon() {
  return (
    <svg
      className="h-4 w-4"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.7}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M20 12a8 8 0 1 1-2.34-5.66" />
      <path d="M20 4v4h-4" />
    </svg>
  );
}

export default function IngestMenu({
  ingests,
  selected,
  monitored = null,
  onSelect,
  connected,
  controls,
  pending,
  onToggleMute,
  onToggleVisibility,
  onRestart,
}: IngestMenuProps) {
  const ordered = sortIngests(ingests);
  const activeCount = ordered.filter((i) => i.ready).length;
  const [fixing, setFixing] = useState<string | null>(null);
  const fixTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (fixTimer.current) clearTimeout(fixTimer.current);
    },
    [],
  );

  const handleFix = (id: string) => {
    onRestart(id);
    setFixing(id);
    if (fixTimer.current) clearTimeout(fixTimer.current);
    fixTimer.current = setTimeout(() => setFixing(null), 1000);
  };

  if (ordered.length === 0) {
    return (
      <p className="text-sm text-text-faint" aria-live="polite">
        {connected
          ? 'No ingests yet. Push a feed to your keyed ingest URL.'
          : 'Connecting to status feed…'}
      </p>
    );
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <span className="text-xs font-medium uppercase tracking-[0.12em] text-text-faint">
          Ingest Feeds
        </span>
        <Badge tone={activeCount > 0 ? 'success' : 'default'}>
          {activeCount} active
        </Badge>
      </div>

      <div className="flex flex-col gap-2">
        {ordered.map((ingest) => {
          const isActive = ingest.id === selected;
          const control = controls[ingest.id];
          const muteOn = control?.muted === true;
          const hidden = control?.visible === false;
          const muteReady = typeof control?.muted === 'boolean';
          const visReady = typeof control?.visible === 'boolean';
          const canFix = control?.restartable === true;
          return (
            <div
              key={ingest.id}
              data-testid="ingest-row"
              className="flex items-center gap-1.5"
            >
              <Button
                variant={isActive ? 'primary' : 'secondary'}
                size="md"
                className="min-w-0 flex-1 justify-between"
                onClick={() => onSelect(ingest.id)}
                aria-pressed={isActive}
              >
                <span className="flex min-w-0 items-center gap-2">
                  <span
                    className={`h-2 w-2 shrink-0 rounded-full ${
                      ingest.ready ? 'bg-success' : 'bg-border'
                    }`}
                  />
                  <span className="truncate">{ingest.id}</span>
                  {ingest.id === monitored && (
                    <Badge
                      tone="primary"
                      className={
                        isActive
                          ? 'bg-white/20 text-on-primary ring-white/30'
                          : undefined
                      }
                    >
                      Monitored
                    </Badge>
                  )}
                </span>
                <span
                  className={`shrink-0 text-xs tabular ${isActive ? '' : 'opacity-80'}`}
                >
                  {ingest.ready ? `${ingest.bitrate} kbps` : 'offline'}
                </span>
              </Button>
              <Button
                variant={muteOn ? 'warning' : 'secondary'}
                size="sm"
                className="px-2"
                onClick={() => onToggleMute(ingest.id)}
                disabled={!muteReady || pending === `${ingest.id}:mute`}
                aria-pressed={muteOn}
                aria-label={
                  muteOn ? `Unmute ${ingest.id}` : `Mute ${ingest.id}`
                }
                title={
                  muteReady ? (muteOn ? 'Unmute' : 'Mute') : 'No OBS source'
                }
              >
                <SpeakerIcon muted={muteOn} />
              </Button>
              <Button
                variant={hidden ? 'warning' : 'secondary'}
                size="sm"
                className="px-2"
                onClick={() => onToggleVisibility(ingest.id)}
                disabled={!visReady || pending === `${ingest.id}:visible`}
                aria-pressed={hidden}
                aria-label={hidden ? `Show ${ingest.id}` : `Hide ${ingest.id}`}
                title={
                  visReady
                    ? hidden
                      ? 'Show source'
                      : 'Hide source'
                    : 'No OBS source'
                }
              >
                <EyeIcon hidden={hidden} />
              </Button>
              <Button
                variant={fixing === ingest.id ? 'warning' : 'secondary'}
                size="sm"
                className="px-2"
                onClick={() => handleFix(ingest.id)}
                disabled={!canFix || pending === `${ingest.id}:restart`}
                aria-label={`Fix ${ingest.id}`}
                title={
                  canFix ? 'Restart source (fix glitches)' : 'Not restartable'
                }
              >
                <FixIcon />
              </Button>
            </div>
          );
        })}
      </div>
    </div>
  );
}
