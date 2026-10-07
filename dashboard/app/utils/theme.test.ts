// SPDX-FileCopyrightText: 2026 OpenIRLNodeKit contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getTheme, onThemeChange, setTheme, themes } from './theme';

const STORAGE_KEY = 'oink-theme';

describe('theme', () => {
  beforeEach(() => {
    localStorage.clear();
    document.documentElement.removeAttribute('data-theme');
  });

  it('returns the default rose theme when nothing is stored', () => {
    expect(getTheme()).toBe('rose');
  });

  it('returns a stored valid theme', () => {
    localStorage.setItem(STORAGE_KEY, 'amber');
    expect(getTheme()).toBe('amber');
  });

  it('falls back to rose for an invalid stored theme', () => {
    localStorage.setItem(STORAGE_KEY, 'hotpink');
    expect(getTheme()).toBe('rose');
  });

  it('persists and applies a theme', () => {
    setTheme('zinc');
    expect(localStorage.getItem(STORAGE_KEY)).toBe('zinc');
    expect(document.documentElement.dataset.theme).toBe('zinc');
  });

  it('notifies subscribers on theme change', () => {
    const cb = vi.fn();
    onThemeChange(cb);
    setTheme('stone');
    expect(cb).toHaveBeenCalledWith('stone');
  });

  it('exposes the theme catalogue', () => {
    expect(themes).toHaveLength(6);
    expect(new Set(themes.map((t) => t.id)).size).toBe(6);
  });
});
