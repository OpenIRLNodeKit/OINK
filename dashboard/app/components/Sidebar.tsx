"use client";
// SPDX-FileCopyrightText: 2026 OpenIRLNodeKit contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useEffect, useState } from 'react';
import { NavLink } from 'react-router';
import { version as APP_VERSION } from '../../package.json';
import { useEffectiveRole } from '../lib/auth-context';
import BrandIcon from './BrandIcon';

// Pages a viewer (read-only) account is allowed to browse. Everything else in
// the nav is hidden for viewers; the server still enforces every route.
const VIEWER_LINKS = new Set(['dashboard', 'assets', 'recordings', 'settings']);

const items: {
  key: string;
  name: string;
  href: string;
  icon: string;
}[] = [
  {
    key: 'dashboard',
    name: 'Dashboard',
    href: '/dashboard',
    icon: 'M2.25 12l8.954-8.955c.44-.439 1.152-.439 1.591 0L21.75 12M4.5 9.75v10.125c0 .621.504 1.125 1.125 1.125H9.75v-4.875c0-.621.504-1.125 1.125-1.125h2.25c.621 0 1.125.504 1.125 1.125V21h4.125c.621 0 1.125-.504 1.125-1.125V9.75M8.25 21h8.25',
  },
  {
    key: 'ingest',
    name: 'Ingest',
    href: '/ingest',
    icon: 'M8.288 15.038a5.25 5.25 0 017.424 0M5.106 11.856c3.807-3.808 9.98-3.808 13.788 0M1.924 8.674c5.565-5.565 14.587-5.565 20.152 0M12.53 18.22l-.53.53-.53-.53a.75.75 0 011.06 0z',
  },
  {
    key: 'assets',
    name: 'Assets',
    href: '/assets',
    icon: 'M2.25 12.75V12A2.25 2.25 0 014.5 9.75h15A2.25 2.25 0 0121.75 12v.75m-8.69-6.44l-2.12-2.12a1.5 1.5 0 00-1.061-.44H4.5A2.25 2.25 0 002.25 6v12a2.25 2.25 0 002.25 2.25h15A2.25 2.25 0 0021.75 18V9a2.25 2.25 0 00-2.25-2.25h-5.379a1.5 1.5 0 01-1.06-.44z',
  },
  {
    key: 'recordings',
    name: 'Recordings',
    href: '/recordings',
    icon: 'M21 12a9 9 0 11-18 0 9 9 0 0118 0zM15.91 11.672a.375.375 0 010 .656l-5.603 3.113a.375.375 0 01-.557-.328V8.887c0-.286.307-.466.557-.327l5.603 3.112z',
  },
  {
    key: 'overlays',
    name: 'Overlays',
    href: '/overlays',
    icon: 'M12 3l9 5.25v7.5L12 21l-9-5.25v-7.5L12 3zm0 0v18M3 8.25L12 3l9 5.25',
  },
  {
    key: 'settings',
    name: 'Settings',
    href: '/settings',
    icon: 'M9.594 3.94c.09-.542.56-.94 1.11-.94h2.593c.55 0 1.02.398 1.11.94l.213 1.281c.063.374.313.686.645.87.074.04.147.083.22.127.324.196.72.257 1.075.124l1.217-.456a1.125 1.125 0 011.37.49l1.296 2.247a1.125 1.125 0 01-.26 1.431l-1.003.827c-.293.24-.438.613-.431.992a6.759 6.759 0 010 .255c-.007.378.138.75.43.99l1.005.828c.424.35.534.954.26 1.43l-1.298 2.247a1.125 1.125 0 01-1.369.491l-1.217-.456c-.355-.133-.75-.072-1.076.124a6.57 6.57 0 01-.22.128c-.331.183-.581.495-.644.869l-.213 1.28c-.09.543-.56.941-1.11.941h-2.594c-.55 0-1.02-.398-1.11-.94l-.213-1.281c-.062-.374-.312-.686-.644-.87a6.52 6.52 0 01-.22-.127c-.325-.196-.72-.257-1.076-.124l-1.217.456a1.125 1.125 0 01-1.369-.49l-1.297-2.247a1.125 1.125 0 01.26-1.431l1.004-.827c.292-.24.437-.613.43-.992a6.932 6.932 0 010-.255c.007-.378-.138-.75-.43-.99l-1.004-.828a1.125 1.125 0 01-.26-1.43l1.297-2.247a1.125 1.125 0 011.37-.491l1.216.456c.356.133.751.072 1.076-.124.072-.044.146-.087.22-.128.332-.183.582-.495.644-.869l.214-1.28z M15 12a3 3 0 11-6 0 3 3 0 016 0z',
  },
];

export function Sidebar({ activePage = 'dashboard' }: { activePage?: string }) {
  const [open, setOpen] = useState(false);
  const isViewer = useEffectiveRole() === 'viewer';
  const visibleItems = isViewer
    ? items.filter((item) => VIEWER_LINKS.has(item.key))
    : items;

  useEffect(() => {
    function setDrawerOpen(value: boolean) {
      setOpen(value);
      document.body.style.overflow = value ? 'hidden' : '';
    }

    function handleClick(e: MouseEvent) {
      const target = e.target as HTMLElement;
      if (target.closest('[data-sidebar-trigger]')) setDrawerOpen(true);
      if (target.closest('[data-sidebar-close]')) setDrawerOpen(false);
      if (target.closest('#sidebar-backdrop')) setDrawerOpen(false);
    }

    function handleKeydown(e: KeyboardEvent) {
      if (e.key === 'Escape') setDrawerOpen(false);
    }

    function handleResize() {
      if (window.innerWidth >= 1280) setDrawerOpen(false);
    }

    document.addEventListener('click', handleClick);
    document.addEventListener('keydown', handleKeydown);
    window.addEventListener('resize', handleResize);

    return () => {
      document.removeEventListener('click', handleClick);
      document.removeEventListener('keydown', handleKeydown);
      window.removeEventListener('resize', handleResize);
      document.body.style.overflow = '';
    };
  }, []);

  return (
    <>
      <aside
        id="app-sidebar"
        data-open={open ? 'true' : undefined}
        className="flex w-72 shrink-0 flex-col border-r border-border-subtle bg-bg-sidebar"
      >
        <div className="px-6 pt-6 pb-4">
          <a href="/dashboard" className="block">
            <BrandIcon variant="logo" className="h-8 w-auto" />
          </a>
        </div>

        <nav className="flex-1 overflow-y-auto px-3 pb-4">
          <ul className="space-y-0.5">
            {visibleItems.map((item) => {
              const isActive = activePage === item.key;
              return (
                <li key={item.key} className="relative">
                  {isActive && (
                    <span
                      className="absolute left-0 top-1/2 h-4 w-[3px] -translate-y-1/2 rounded-full bg-primary"
                    />
                  )}
                  <NavLink
                    to={item.href}
                    aria-current={isActive ? 'page' : undefined}
                    className={`flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition-colors ${
                      isActive
                        ? 'bg-primary-soft text-primary'
                        : 'text-text-secondary hover:bg-bg-elevated hover:text-text-primary'
                    }`}
                  >
                    <svg
                      className={`h-[18px] w-[18px] shrink-0 ${
                        isActive ? 'text-primary' : 'text-text-faint'
                      }`}
                      fill="none"
                      viewBox="0 0 24 24"
                      stroke="currentColor"
                    >
                      <path
                        stroke-linecap="round"
                        stroke-linejoin="round"
                        stroke-width="1.75"
                        d={item.icon}
                      />
                    </svg>
                    {item.name}
                  </NavLink>
                </li>
              );
            })}
          </ul>
        </nav>

        <div className="px-4 py-3 border-t border-border-subtle">
          <a
            href="https://github.com/sponsors/ImaginaryResources"
            target="_blank"
            rel="noopener noreferrer"
            className="mb-1 flex items-center gap-2 rounded-lg px-2 py-1.5 text-xs font-medium text-text-faint transition-colors hover:text-primary"
          >
            <svg className="h-3.5 w-3.5 shrink-0" fill="currentColor" viewBox="0 0 24 24">
              <path d="M11.645 20.91l-.007-.003-.022-.012a15.247 15.247 0 01-.383-.218 25.18 25.18 0 01-4.244-3.17C4.688 15.36 2.25 12.174 2.25 8.25 2.25 5.322 4.714 3 7.688 3A5.5 5.5 0 0112 5.052 5.5 5.5 0 0116.313 3c2.973 0 5.437 2.322 5.437 5.25 0 3.925-2.438 7.111-4.739 9.256a25.175 25.175 0 01-4.244 3.17 15.247 15.247 0 01-.383.219l-.022.012-.007.004-.003.001a.752.752 0 01-.704 0l-.003-.001z" />
            </svg>
            Sponsor
          </a>
          <div className="flex items-center gap-2.5 rounded-lg px-2 py-1.5">
            <span className="relative flex h-2 w-2">
              <span
                className="absolute inline-flex h-full w-full animate-ping rounded-full bg-success opacity-60"
              ></span>
              <span className="relative inline-flex h-2 w-2 rounded-full bg-success"></span>
            </span>
            <div className="leading-tight">
              <p className="text-xs font-medium text-text-secondary">System Online</p>
              <p className="text-[10px] tabular text-text-faint">OINK v{APP_VERSION}</p>
            </div>
          </div>
        </div>
      </aside>

      {/* Mobile backdrop */}
      <div id="sidebar-backdrop" data-open={open ? 'true' : undefined} className="xl:hidden"></div>
    </>
  );
}
