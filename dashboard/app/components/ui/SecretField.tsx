'use client';
// SPDX-FileCopyrightText: 2026 OpenIRLNodeKit contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useEffect, useRef, useState } from 'react';
import { cn } from '../../lib/cn';
import { copyText } from '../../lib/copy';
import { Field } from './Field';

interface SecretFieldProps {
  id: string;
  label: string;
  value: string;
  hint?: string;
}

export function SecretField({ id, label, value, hint }: SecretFieldProps) {
  const [revealed, setRevealed] = useState(false);
  const [copied, setCopied] = useState(false);
  const copyTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (copyTimer.current) clearTimeout(copyTimer.current);
    },
    [],
  );

  const handleCopy = async () => {
    const ok = await copyText(value);
    if (!ok) return;
    setCopied(true);
    if (copyTimer.current) clearTimeout(copyTimer.current);
    copyTimer.current = setTimeout(() => setCopied(false), 2000);
  };

  return (
    <Field label={label} htmlFor={id} hint={hint}>
      <input
        id={id}
        type="text"
        readOnly
        aria-label={label}
        value={value}
        data-blurred={revealed ? undefined : 'true'}
        className={cn(
          'w-full rounded-control bg-bg-card px-3.5 py-2 text-sm font-mono text-text-primary ring-1 ring-inset ring-border-subtle',
          revealed ? 'blur-none [filter:none]' : '[filter:blur(6px)]',
        )}
      />
      <div className="flex justify-end gap-4">
        <button
          type="button"
          onClick={() => setRevealed((r) => !r)}
          className="text-xs font-medium text-text-secondary hover:text-primary transition-colors"
        >
          {revealed ? 'Hide' : 'View'}
        </button>
        <button
          type="button"
          onClick={handleCopy}
          className={cn(
            'text-xs font-medium transition-colors',
            copied ? 'text-success' : 'text-text-secondary hover:text-primary',
          )}
        >
          {copied ? 'Copied' : 'Copy'}
        </button>
      </div>
    </Field>
  );
}
