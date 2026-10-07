// SPDX-FileCopyrightText: 2026 OpenIRLNodeKit contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
import { beforeEach, describe, expect, it } from 'vitest';
import { csrfHeaders } from './csrf';

describe('csrfHeaders', () => {
  beforeEach(() => {
    document.cookie = 'oink_csrf=; Max-Age=0; path=/';
  });

  it('echoes the readable cookie', () => {
    document.cookie = 'oink_csrf=abc123; path=/';
    expect(csrfHeaders()).toEqual({ 'X-CSRF-Token': 'abc123' });
  });

  it('returns no header when the cookie is absent', () => {
    expect(csrfHeaders()).toEqual({});
  });
});
