'use client';
// SPDX-FileCopyrightText: 2026 OpenIRLNodeKit contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import type { UseObsScenesResult } from '../../lib/useObsScenes';
import { Badge, Button } from '../ui';

export interface SceneSwitcherProps extends UseObsScenesResult {
  /** Scene names governed by the NOALBS auto-switcher (from its config). */
  managedScenes?: string[];
  /** True when NOALBS is running and `bitrateSwitcherEnabled`. */
  managedActive?: boolean;
}

function RobotIcon({ active }: { active: boolean }) {
  return (
    <svg
      data-testid="robot-badge"
      className={`h-5 w-5 shrink-0 ${active ? '' : 'opacity-50'}`}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.6}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <title>Managed by the auto scene switcher</title>
      {/* antenna */}
      <path d="M12 6.5V4.2" />
      <circle cx="12" cy="3" r="1.2" fill="currentColor" stroke="none" />
      {/* head */}
      <rect x="4.75" y="6.5" width="14.5" height="11" rx="3" />
      {/* ears */}
      <path d="M4.75 11H3M19.25 11H21" />
      {/* eyes */}
      <circle cx="9.25" cy="11" r="1.1" fill="currentColor" stroke="none" />
      <circle cx="14.75" cy="11" r="1.1" fill="currentColor" stroke="none" />
      {/* mouth */}
      <path d="M9.5 14.75h5" />
    </svg>
  );
}

export default function SceneSwitcher({
  scenes,
  current,
  loading,
  error,
  pending,
  switchScene,
  managedScenes = [],
  managedActive = false,
}: SceneSwitcherProps) {
  if (loading && scenes.length === 0) {
    return (
      <p className="text-sm text-text-faint" aria-live="polite">
        Loading scenes…
      </p>
    );
  }

  if (scenes.length === 0) {
    return (
      <p className="text-sm text-text-faint">
        No scenes available. Connect OBS to see scenes here.
      </p>
    );
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <span className="text-xs font-medium uppercase tracking-[0.12em] text-text-faint">
          Current Scene
        </span>
        <Badge tone={current ? 'primary' : 'default'}>
          {current || 'Unknown'}
        </Badge>
      </div>

      <div className="flex flex-col gap-2" role="group" aria-label="OBS scenes">
        {scenes.map((scene) => {
          const isActive = scene === current;
          const isPending = pending === scene;
          const isManaged = managedScenes.includes(scene);
          return (
            <Button
              key={scene}
              variant={isActive ? 'primary' : 'secondary'}
              size="md"
              className="w-full"
              onClick={() => switchScene(scene)}
              disabled={pending !== null}
              aria-pressed={isActive}
            >
              {isManaged && <RobotIcon active={managedActive} />}
              {isPending ? 'Switching…' : scene}
            </Button>
          );
        })}
      </div>

      {error && (
        <p className="text-xs text-danger" role="alert" aria-live="polite">
          {error}
        </p>
      )}
    </div>
  );
}
