'use client';
// SPDX-FileCopyrightText: 2026 OpenIRLNodeKit contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useEffect, useRef, useState } from 'react';
import { cn } from '../../../lib/cn';
import { copyText } from '../../../lib/copy';
import type { BadgeProps } from '../../ui/Badge';
import { Badge } from '../../ui/Badge';

export interface ProtocolCardDetail {
  label: string;
  value: string;
  secret?: boolean;
}

interface ProtocolCardProps {
  id: string;
  label: string;
  tone: BadgeProps['tone'];
  hint?: string;
  value: string;
  disabled?: boolean;
  details?: ProtocolCardDetail[];
}

export default function ProtocolCard({
  id,
  label,
  tone,
  hint,
  value,
  disabled = false,
  details,
}: ProtocolCardProps) {
  const [revealed, setRevealed] = useState(false);
  const [copied, setCopied] = useState<string | null>(null);
  const copyTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (copyTimer.current) clearTimeout(copyTimer.current);
    },
    [],
  );

  const handleCopy = async (text: string, key: string) => {
    if (disabled) return;
    const ok = await copyText(text);
    if (!ok) return;
    setCopied(key);
    if (copyTimer.current) clearTimeout(copyTimer.current);
    copyTimer.current = setTimeout(() => setCopied(null), 2000);
  };

  const hasDetails = !!details && details.length > 0;
  const hasSecret = !!details?.some((d) => d.secret);
  const showReveal = !hasDetails || hasSecret;

  const blurFor = (secret: boolean) =>
    !secret || (revealed && !disabled)
      ? 'blur-none [filter:none]'
      : '[filter:blur(6px)]';

  const inputClass =
    'w-full rounded-control bg-bg-elevated px-2 py-1.5 text-xs font-mono text-text-primary ring-1 ring-inset ring-border-subtle';

  return (
    <div className={cn('surface surface-hover p-4', disabled && 'opacity-60')}>
      <div className="flex items-center justify-between mb-2">
        <Badge tone={tone}>{label}</Badge>
        {hint && <span className="text-xs text-text-secondary">{hint}</span>}
      </div>

      {hasDetails ? (
        <div className="space-y-2">
          {details.map((d) => (
            <div key={d.label}>
              <div className="mb-1 flex items-center justify-between">
                <span className="text-[10px] font-medium uppercase tracking-wide text-text-secondary">
                  {d.label}
                </span>
                <button
                  type="button"
                  onClick={() => handleCopy(d.value, d.label)}
                  disabled={disabled}
                  className="text-[11px] text-text-secondary hover:text-primary transition-colors disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:text-text-secondary"
                >
                  Copy
                </button>
              </div>
              <input
                type="text"
                readOnly
                value={disabled ? '' : d.value}
                aria-label={d.label}
                data-blurred={d.secret && !revealed ? 'true' : undefined}
                className={cn(inputClass, blurFor(!!d.secret))}
              />
            </div>
          ))}
        </div>
      ) : (
        <input
          type="text"
          readOnly
          value={disabled ? '' : value}
          id={id}
          aria-label={`${label} URL`}
          data-blurred={revealed ? undefined : 'true'}
          className={cn(inputClass, blurFor(true))}
        />
      )}

      <div className="relative mt-2 flex gap-2">
        {showReveal && (
          <button
            type="button"
            onClick={() => setRevealed((r) => !r)}
            disabled={disabled}
            className="flex-1 text-xs text-text-secondary hover:text-primary transition-colors disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:text-text-secondary"
          >
            {revealed ? 'Hide' : 'View'}
          </button>
        )}
        {!hasDetails && (
          <button
            type="button"
            onClick={() => handleCopy(value, value)}
            disabled={disabled}
            className="flex-1 text-xs text-text-secondary hover:text-primary transition-colors disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:text-text-secondary"
          >
            Copy
          </button>
        )}

        <div
          role="status"
          aria-live="polite"
          className={cn(
            'pointer-events-none absolute bottom-full left-1/2 z-10 mb-1.5 -translate-x-1/2 flex items-center gap-1 whitespace-nowrap rounded-md bg-bg-card px-2 py-1 text-xs font-medium text-text-primary shadow-pop ring-1 ring-inset ring-border-subtle transition-all duration-300',
            copied ? 'translate-y-0 opacity-100' : 'translate-y-1 opacity-0',
          )}
        >
          <svg
            aria-hidden="true"
            className="h-3.5 w-3.5 text-success"
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
          >
            <path
              stroke-linecap="round"
              stroke-linejoin="round"
              stroke-width="2"
              d="M4.5 12.75l6 6 9-13.5"
            />
          </svg>
          Copied
        </div>
      </div>
    </div>
  );
}
