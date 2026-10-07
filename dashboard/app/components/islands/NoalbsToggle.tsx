'use client';
// SPDX-FileCopyrightText: 2026 OpenIRLNodeKit contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { Toggle } from '../ui';

export interface NoalbsToggleProps {
  running: boolean | null;
  pending: boolean;
  error: string | null;
  onToggle: (next: boolean) => void;
}

export default function NoalbsToggle({
  running,
  pending,
  error,
  onToggle,
}: NoalbsToggleProps) {
  const isLoading = running === null;
  const isDisabled = pending || isLoading;

  return (
    <div className="flex items-center gap-2">
      <Toggle
        name="noalbs-toggle"
        label="Stream drop protection"
        checked={running === true}
        onChange={(e) => onToggle(e.target.checked)}
        disabled={isDisabled}
      />
      {isLoading && (
        <span className="text-xs text-text-faint" aria-live="polite">
          Loading…
        </span>
      )}
      {pending && (
        <span className="text-xs text-warning" aria-live="polite">
          Updating…
        </span>
      )}
      {error && (
        <span className="text-xs text-danger" aria-live="polite" role="alert">
          {error}
        </span>
      )}
    </div>
  );
}
