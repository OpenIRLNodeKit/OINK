"use client";
// SPDX-FileCopyrightText: 2026 OpenIRLNodeKit contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { forwardRef, type InputHTMLAttributes } from 'react';
import { cn } from '../../lib/cn';

interface ToggleProps
  extends Omit<InputHTMLAttributes<HTMLInputElement>, 'type'> {
  label?: string;
  description?: string;
}

export const Toggle = forwardRef<HTMLInputElement, ToggleProps>(
  ({ className, label, description, id, ...props }, ref) => {
    const toggleId = id ?? props.name;
    return (
      <div className={cn('flex items-center justify-between gap-4', className)}>
        {(label || description) && (
          <div>
            {label && <p className="text-sm font-medium">{label}</p>}
            {description && (
              <p className="mt-0.5 text-[13px] text-text-secondary">
                {description}
              </p>
            )}
          </div>
        )}
        <label className="relative inline-flex shrink-0 cursor-pointer items-center">
          <input
            ref={ref}
            type="checkbox"
            id={toggleId}
            className="peer sr-only"
            {...props}
          />
          <div className="h-6 w-11 rounded-full bg-border-subtle ring-1 ring-inset ring-border transition-colors after:absolute after:left-[3px] after:top-[3px] after:h-[18px] after:w-[18px] after:rounded-full after:bg-text-primary after:shadow-sm after:transition-transform peer-checked:bg-primary peer-checked:ring-primary peer-checked:after:translate-x-5 peer-focus-visible:ring-2 peer-focus-visible:ring-primary peer-disabled:opacity-50 peer-disabled:cursor-not-allowed" />
        </label>
      </div>
    );
  },
);
Toggle.displayName = 'Toggle';
