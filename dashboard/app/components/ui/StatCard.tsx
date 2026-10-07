"use client";
// SPDX-FileCopyrightText: 2026 OpenIRLNodeKit contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import type { HTMLAttributes, ReactNode } from 'react';
import { cn } from '../../lib/cn';

const tones = {
  default: 'text-text-primary',
  success: 'text-success',
  warning: 'text-warning',
  danger: 'text-danger',
} as const;

export interface StatCardProps extends HTMLAttributes<HTMLDivElement> {
  label: string;
  value: ReactNode;
  sub?: ReactNode;
  tone?: keyof typeof tones;
  icon?: ReactNode;
  mono?: boolean;
  hint?: string;
}

export function StatCard({
  className,
  label,
  value,
  sub,
  tone = 'default',
  icon,
  mono = true,
  hint,
  ...props
}: StatCardProps) {
  return (
    <div className={cn('surface surface-hover p-4', className)} {...props}>
      <div className="flex items-center justify-between gap-2">
        <p className="text-xs font-medium uppercase tracking-[0.12em] text-text-faint">
          {label}
        </p>
        {icon && (
          <div className="text-text-faint [&_svg]:h-4 [&_svg]:w-4">{icon}</div>
        )}
      </div>
      <p
        className={cn(
          'mt-2 text-2xl font-semibold tracking-tight',
          mono && 'tabular',
          tones[tone],
        )}
      >
        {value}
      </p>
      {sub && <p className="mt-1 text-[13px] text-text-secondary">{sub}</p>}
      {hint && <p className="mt-0.5 text-[11px] text-text-faint">{hint}</p>}
    </div>
  );
}
