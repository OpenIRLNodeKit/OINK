"use client";
// SPDX-FileCopyrightText: 2026 OpenIRLNodeKit contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useEffect, useState } from 'react';
import { getTheme, onThemeChange, setTheme, themes } from '../../utils/theme';

export default function ThemeSelector() {
  const [theme, setThemeState] = useState('slate');

  useEffect(() => {
    setThemeState(getTheme());
    const unsubscribe = onThemeChange((newTheme) => {
      setThemeState(newTheme);
    });
    return unsubscribe;
  }, []);

  return (
    <label className="block">
      <span className="sr-only">Select theme</span>
      <select
        value={theme}
        onChange={(e) => setTheme(e.target.value as (typeof themes)[number]['id'])}
        className="w-56 cursor-pointer rounded-control bg-bg-card px-3.5 py-2 text-sm text-text-primary ring-1 ring-inset ring-border-subtle transition-shadow focus:ring-2 focus:ring-primary"
      >
        {themes.map((t) => (
          <option key={t.id} value={t.id}>
            {t.name} — {t.description}
          </option>
        ))}
      </select>
    </label>
  );
}
