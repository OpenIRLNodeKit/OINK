// SPDX-FileCopyrightText: 2026 OpenIRLNodeKit contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
type Theme = 'rose' | 'zinc' | 'neutral' | 'slate' | 'amber' | 'stone';

export const themes = [
  { id: 'rose' as Theme, name: 'Rose (Default)', description: 'Soft pink/red warmth' },
  { id: 'zinc' as Theme, name: 'Zinc', description: 'True neutral gray, minimal' },
  { id: 'neutral' as Theme, name: 'Neutral (Light)', description: 'Clean light mode' },
  { id: 'slate' as Theme, name: 'Slate', description: 'Cool blue-gray, professional' },
  { id: 'amber' as Theme, name: 'Amber', description: 'Warm amber tones' },
  { id: 'stone' as Theme, name: 'Stone', description: 'Warm earth tones' },
] as const;

export const DEFAULT_THEME = 'rose' as Theme;

function isValidTheme(value: unknown): value is Theme {
  return typeof value === 'string' && themes.some((t) => t.id === value);
}

export function getTheme(): Theme {
  if (typeof window === 'undefined') return DEFAULT_THEME;
  const stored = localStorage.getItem('oink-theme');
  return isValidTheme(stored) ? stored : DEFAULT_THEME;
}

export function setTheme(theme: Theme) {
  if (typeof window === 'undefined') return;
  localStorage.setItem('oink-theme', theme);
  document.documentElement.dataset.theme = theme;
  window.dispatchEvent(new CustomEvent('themechange', { detail: theme }));
}

export function onThemeChange(cb: (theme: Theme) => void) {
  if (typeof window === 'undefined') return () => {};
  const handler = (e: CustomEvent) => cb(e.detail);
  window.addEventListener('themechange', handler as EventListener);
  return () => window.removeEventListener('themechange', handler as EventListener);
}
