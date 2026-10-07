// SPDX-FileCopyrightText: 2026 OpenIRLNodeKit contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_TWITCH_CLIPS_CONFIG,
  buildTwitchClipsUrl,
  TWITCH_CLIPS_BASE_URL,
} from './twitchClipsPlayer';

describe('buildTwitchClipsUrl', () => {
  it('produces the parameter set from defaults for a channel', () => {
    const url = buildTwitchClipsUrl('my_stream', DEFAULT_TWITCH_CLIPS_CONFIG);
    expect(url.startsWith(`${TWITCH_CLIPS_BASE_URL}?`)).toBe(true);
    const params = new URLSearchParams(url.split('?')[1]);
    expect(params.get('channel')).toBe('my_stream');
    expect(params.get('mainAccount')).toBe('my_stream');
    expect(params.get('limit')).toBe('100');
    expect(params.get('dateRange')).toBe('360');
    expect(params.get('themeOption')).toBe('2');
    expect(params.get('preferFeatured')).toBe('true');
    expect(params.get('showText')).toBe('false');
    expect(params.get('cache')).toBe('true');
  });

  it('reflects boolean toggles in the query string', () => {
    const url = buildTwitchClipsUrl('my_stream', {
      ...DEFAULT_TWITCH_CLIPS_CONFIG,
      preferFeatured: false,
      showText: true,
      progressBar: true,
      profileBadge: true,
      showDetails: true,
    });
    const params = new URLSearchParams(url.split('?')[1]);
    expect(params.get('preferFeatured')).toBe('false');
    expect(params.get('showText')).toBe('true');
    expect(params.get('progressBar')).toBe('true');
    expect(params.get('profileBadge')).toBe('true');
    expect(params.get('showDetails')).toBe('true');
  });

  it('keeps server-side cache enabled by default', () => {
    const url = buildTwitchClipsUrl('my_stream', DEFAULT_TWITCH_CLIPS_CONFIG);
    const params = new URLSearchParams(url.split('?')[1]);
    expect(params.get('cache')).toBe('true');
  });

  it('serializes numeric parameters', () => {
    const url = buildTwitchClipsUrl('my_stream', {
      ...DEFAULT_TWITCH_CLIPS_CONFIG,
      limit: 25,
      dateRange: 7,
      delay: 3,
      themeOption: 7,
    });
    const params = new URLSearchParams(url.split('?')[1]);
    expect(params.get('limit')).toBe('25');
    expect(params.get('dateRange')).toBe('7');
    expect(params.get('delay')).toBe('3');
    expect(params.get('themeOption')).toBe('7');
  });

  it('URL-encodes special characters in text fields', () => {
    const url = buildTwitchClipsUrl('user1,user two&more', {
      ...DEFAULT_TWITCH_CLIPS_CONFIG,
      detailsText: 'hi {channel} & {title}',
    });
    const params = new URLSearchParams(url.split('?')[1]);
    expect(params.get('channel')).toBe('user1,user two&more');
    expect(params.get('mainAccount')).toBe('user1,user two&more');
    expect(params.get('detailsText')).toBe('hi {channel} & {title}');
    expect(url).toContain('channel=user1%2Cuser+two%26more');
  });
});
