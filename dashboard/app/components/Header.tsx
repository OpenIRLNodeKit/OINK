"use client";
// SPDX-FileCopyrightText: 2026 OpenIRLNodeKit contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { logout } from '../lib/auth';
import { useAuth } from '../lib/auth-context';
import ThemeToggle from './ThemeToggle';

interface HeaderProps {
  title?: string;
}

async function handleLogout() {
  await logout();
  window.location.replace('/');
}

function initialsFor(name: string): string {
  return name
    .split(/[^a-z0-9]+/i)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0].toUpperCase())
    .join('')
    .padEnd(2, '?')
    .slice(0, 2);
}

export function Header({ title = 'Dashboard' }: HeaderProps) {
  const { user, enabled } = useAuth();
  const displayName = enabled && user ? user.username : 'Local';
  const displayInitials = enabled && user ? initialsFor(user.username) : 'LK';

  return (
    <header
      className="sticky top-0 z-40 flex h-14 items-center justify-between gap-4 border-b border-border-subtle bg-bg-dark/75 px-4 backdrop-blur-xl sm:h-16 sm:px-6"
    >
      <div className="flex min-w-0 items-center gap-3">
        <button
          data-sidebar-trigger
          type="button"
          aria-label="Open navigation"
          className="flex h-9 w-9 items-center justify-center rounded-lg text-text-secondary ring-1 ring-inset ring-border-subtle transition-colors hover:bg-bg-elevated hover:text-text-primary xl:hidden"
        >
          <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path
              stroke-linecap="round"
              stroke-linejoin="round"
              stroke-width="2"
              d="M3.75 6.75h16.5M3.75 12h16.5m-16.5 5.25h16.5"
            />
          </svg>
        </button>
        <nav aria-label="Breadcrumb" className="flex items-center gap-2 text-sm">
          <span className="hidden text-text-faint sm:block">OINK</span>
          <svg
            className="hidden h-3.5 w-3.5 text-text-faint sm:block"
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
          >
            <path
              stroke-linecap="round"
              stroke-linejoin="round"
              stroke-width="2"
              d="m8.25 4.5 7.5 7.5-7.5 7.5"
            />
          </svg>
          <p
            className="truncate text-[15px] font-semibold tracking-tight text-text-primary"
          >
            {title}
          </p>
        </nav>
      </div>

      <div className="flex items-center gap-2 sm:gap-4">
        <div className="flex items-center gap-2.5">
          <div
            className="flex h-8 w-8 items-center justify-center overflow-hidden rounded-full bg-primary text-[11px] font-semibold text-bg-dark"
          >
            {user?.avatarUrl ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={user.avatarUrl}
                alt={`${displayName} avatar`}
                className="h-full w-full object-cover"
              />
            ) : (
              displayInitials
            )}
          </div>
          <span className="hidden text-sm font-medium text-text-secondary md:block">
            {displayName}
          </span>
          {enabled && user && (
            <span className="hidden rounded-full bg-bg-elevated px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-text-faint ring-1 ring-inset ring-border-subtle md:inline-block">
              {user.role}
            </span>
          )}
        </div>
        <button
          type="button"
          onClick={handleLogout}
          className="rounded-lg px-2.5 py-1.5 text-sm font-medium text-text-secondary transition-colors hover:bg-bg-elevated hover:text-text-primary"
        >
          Logout
        </button>
        <ThemeToggle />
      </div>
    </header>
  );
}
