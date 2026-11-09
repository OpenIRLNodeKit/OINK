"use client";
// SPDX-FileCopyrightText: 2026 OpenIRLNodeKit contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { forwardRef, type ButtonHTMLAttributes } from 'react';
import { cn } from '../../lib/cn';

const variants = {
  primary:
    'bg-primary text-on-primary shadow-sm hover:bg-primary-hover active:bg-primary focus-visible:ring-primary/50',
  secondary:
    'bg-bg-card text-text-primary ring-1 ring-inset ring-border-subtle hover:bg-bg-elevated hover:ring-border active:bg-bg-elevated focus-visible:ring-primary/40',
  success:
    'bg-success text-on-primary hover:brightness-110 active:brightness-95 focus-visible:ring-success/50',
  danger:
    'bg-danger-solid text-white hover:brightness-95 active:brightness-90 focus-visible:ring-danger/50',
  warning:
    'bg-warning text-on-primary hover:brightness-110 active:brightness-95 focus-visible:ring-warning/50',
  ghost:
    'bg-transparent text-text-secondary hover:bg-bg-elevated hover:text-text-primary focus-visible:ring-primary/30',
} as const;

const sizes = {
  sm: 'px-2.5 py-1.5 text-xs rounded-control',
  md: 'px-4 py-2 text-sm rounded-control',
  lg: 'px-5 py-2.5 text-[15px] rounded-control',
} as const;

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: keyof typeof variants;
  size?: keyof typeof sizes;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  (
    { className, variant = 'primary', size = 'md', type = 'button', ...props },
    ref,
  ) => (
    <button
      ref={ref}
      type={type}
      className={cn(
        'inline-flex select-none items-center justify-center gap-2 font-medium transition-all duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-offset-bg-dark disabled:opacity-50 disabled:pointer-events-none',
        variants[variant],
        sizes[size],
        className,
      )}
      {...props}
    />
  ),
);
Button.displayName = 'Button';
