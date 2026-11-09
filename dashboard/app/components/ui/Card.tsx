"use client";
// SPDX-FileCopyrightText: 2026 OpenIRLNodeKit contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import type { HTMLAttributes } from 'react';
import { cn } from '../../lib/cn';

interface CardProps extends HTMLAttributes<HTMLDivElement> {
  title?: string;
  description?: string;
  pad?: boolean;
}

export function Card({
  className,
  title,
  description,
  pad = true,
  children,
  ...props
}: CardProps) {
  return (
    <section className={cn('surface', className)} {...props}>
      {title && (
        <div
          className={cn(
            'flex items-start justify-between gap-4',
            pad ? 'p-5 pb-0' : 'px-5 pt-5 pb-0',
          )}
        >
          <div>
            <h3 className="text-sm font-semibold tracking-tight text-text-primary">
              {title}
            </h3>
            {description && (
              <p className="mt-0.5 text-[13px] leading-relaxed text-text-secondary">
                {description}
              </p>
            )}
          </div>
        </div>
      )}
      <div className={cn(pad && 'p-5')}>{children}</div>
    </section>
  );
}
