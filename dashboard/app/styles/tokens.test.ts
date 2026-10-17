// @vitest-environment node
// SPDX-FileCopyrightText: 2026 OpenIRLNodeKit contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// Guards the palette: every theme must keep its text readable on the surface
// it sits on. Fails when someone recolours a token without checking contrast.
const css = readFileSync(new URL('./global.css', import.meta.url), 'utf8');

type Tokens = Record<string, string>;

function parseOklch(value: string): [number, number, number] | null {
  const match = value.match(/oklch\(([^)]+)\)/);
  if (!match) return null;
  const [l, c, h] = match[1].split('/')[0].trim().split(/\s+/);
  const lightness = l.endsWith('%') ? Number.parseFloat(l) / 100 : Number(l);
  return [lightness, Number(c), Number(h)];
}

// OKLCH -> linear sRGB, then WCAG relative luminance. Out-of-gamut channels
// are clamped, which is what the browser does too.
function luminance([l, c, h]: [number, number, number]): number {
  const rad = (h * Math.PI) / 180;
  const a = c * Math.cos(rad);
  const b = c * Math.sin(rad);
  const lp = (l + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const mp = (l - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const sp = (l - 0.0894841775 * a - 1.291485548 * b) ** 3;
  const clamp = (v: number) => Math.min(1, Math.max(0, v));
  return (
    0.2126 * clamp(4.0767416621 * lp - 3.3077115913 * mp + 0.2309699292 * sp) +
    0.7152 * clamp(-1.2684380046 * lp + 2.6097574011 * mp - 0.3413193965 * sp) +
    0.0722 * clamp(-0.0041960863 * lp - 0.7034186147 * mp + 1.707614701 * sp)
  );
}

function contrast(fg: string, bg: string): number {
  const fgColor = parseOklch(fg);
  const bgColor = parseOklch(bg);
  if (!fgColor || !bgColor) throw new Error(`Unparsable token: ${fg} / ${bg}`);
  const [a, b] = [luminance(fgColor), luminance(bgColor)];
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

function declarations(block: string): Tokens {
  const tokens: Tokens = {};
  for (const match of block.matchAll(/--color-([a-z-]+):\s*([^;]+);/g)) {
    tokens[match[1]] = match[2].trim();
  }
  return tokens;
}

const themeBlock = css.match(/@theme\s*\{([\s\S]*?)\n\}/)?.[1] ?? '';
const base = declarations(themeBlock);

const themes: Record<string, Tokens> = {};
for (const match of css.matchAll(
  /\[data-theme="([a-z]+)"\]\s*\{([\s\S]*?)\n\}/g,
)) {
  themes[match[1]] = { ...base, ...declarations(match[2]) };
}

const WHITE = 'oklch(1 0 0)';

const pairs: Array<[label: string, fg: string, bg: string]> = [
  ['primary ink', 'primary', 'on-primary'],
  ['success ink', 'success', 'on-primary'],
  ['warning ink', 'warning', 'on-primary'],
  ['danger button ink', 'danger-solid', 'white'],
  ['danger text', 'danger', 'bg-card'],
  ['faint text', 'text-faint', 'bg-card'],
  ['faint text on elevated', 'text-faint', 'bg-elevated'],
  ['faint text on sidebar', 'text-faint', 'bg-sidebar'],
];

const all = { default: base, ...themes };

describe('theme token contrast', () => {
  it('parses the default and every named theme', () => {
    expect(Object.keys(base).length).toBeGreaterThan(10);
    expect(Object.keys(themes)).toEqual(
      expect.arrayContaining([
        'slate',
        'zinc',
        'neutral',
        'amber',
        'rose',
        'stone',
      ]),
    );
    // Every block must parse; otherwise a new theme silently escapes the guard.
    expect(Object.keys(themes)).toHaveLength(
      [...css.matchAll(/\[data-theme="[a-z]+"\]\s*\{/g)].length,
    );
  });

  for (const [theme, tokens] of Object.entries(all)) {
    for (const [label, fgToken, bgToken] of pairs) {
      it(`${theme}: ${label} >= 4.5:1`, () => {
        const fg = fgToken === 'white' ? WHITE : tokens[fgToken];
        const bg = bgToken === 'white' ? WHITE : tokens[bgToken];
        expect(fg, `${fgToken} missing`).toBeDefined();
        expect(bg, `${bgToken} missing`).toBeDefined();
        expect(contrast(fg, bg)).toBeGreaterThanOrEqual(4.5);
      });
    }
  }
});
