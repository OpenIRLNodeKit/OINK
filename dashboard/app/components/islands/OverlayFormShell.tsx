"use client";
// SPDX-FileCopyrightText: 2026 OpenIRLNodeKit contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import type { ReactNode } from 'react';
import type { ObsBrowserSource } from '../../lib/useObsBrowserSource';
import { Button, Field, Input, Toggle } from '../ui';

interface OverlayFormShellProps {
  url: string;
  canApply: boolean;
  missingText: string;
  sceneOptions: readonly string[];
  showUrlField?: boolean;
  urlFieldId?: string;
  form: ObsBrowserSource;
  children: ReactNode;
}

export default function OverlayFormShell({
  url,
  canApply,
  missingText,
  sceneOptions,
  showUrlField,
  urlFieldId,
  form,
  children,
}: OverlayFormShellProps) {
  const {
    scenes,
    toggleScene,
    copyState,
    handleCopy,
    obsStatus,
    handleApply,
    handleRemove,
  } = form;

  return (
    <div className="space-y-6">
      {children}

      <div className="space-y-3">
        <h4 className="text-sm font-semibold text-text-primary">
          Target scenes
        </h4>
        <p className="text-[13px] text-text-secondary">
          Add the browser source to these OBS scenes (pick one or more).
        </p>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          {sceneOptions.map((scene) => (
            <Toggle
              key={scene}
              name={`scene-${scene}`}
              label={scene}
              checked={scenes.includes(scene)}
              onChange={() => toggleScene(scene)}
            />
          ))}
        </div>
      </div>

      <div className="space-y-3 rounded-card bg-bg-card p-4 ring-1 ring-inset ring-border-subtle">
        <div className="flex items-center justify-between">
          <h4 className="text-sm font-semibold text-text-primary">
            OBS Browser Source URL
          </h4>
          <Button size="sm" variant="secondary" onClick={() => void handleCopy()}>
            {copyState === 'copied' ? 'Copied!' : 'Copy URL'}
          </Button>
        </div>

        {showUrlField && urlFieldId && (
          <Field label="Generated URL" htmlFor={urlFieldId}>
            <Input
              id={urlFieldId}
              readOnly
              className="font-mono text-xs"
              value={url}
            />
          </Field>
        )}

        <div className="flex flex-wrap gap-3 pt-1">
          <a
            href={url || '#'}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center justify-center gap-2 rounded-control bg-bg-card px-4 py-2 text-sm font-medium text-text-primary ring-1 ring-inset ring-border-subtle transition-all duration-150 hover:bg-bg-elevated hover:ring-border active:bg-bg-elevated"
          >
            Preview
          </a>
          <Button onClick={() => void handleApply()} disabled={!canApply}>
            Apply to OBS ({scenes.length > 0 ? scenes.join(', ') : 'no scenes'})
          </Button>
          <Button variant="danger" onClick={() => void handleRemove()}>
            Remove from OBS
          </Button>
        </div>

        {!canApply && <p className="text-[13px] text-warning">{missingText}</p>}

        {obsStatus.status !== 'idle' && (
          <p
            className={`text-[13px] ${obsStatus.status === 'ok' ? 'text-success' : 'text-danger'}`}
          >
            {obsStatus.message}
          </p>
        )}
      </div>
    </div>
  );
}
