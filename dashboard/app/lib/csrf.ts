// SPDX-FileCopyrightText: 2026 OpenIRLNodeKit contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

// CSRF header for requests. The server mints `oink_csrf` at login (readable so
// JS can echo it) and checks it against the signed session; see stack/csrf.js.
// Attached unconditionally — harmless on GET, and one less method table to keep
// in sync with the server. SSR-safe: returns {} when `document` is unavailable.

export function csrfHeaders(): Record<string, string> {
  if (typeof document === 'undefined') return {};
  const match = document.cookie.match(/(?:^|;\s*)oink_csrf=([^;]*)/);
  if (!match) return {};
  return { 'X-CSRF-Token': decodeURIComponent(match[1]) };
}
