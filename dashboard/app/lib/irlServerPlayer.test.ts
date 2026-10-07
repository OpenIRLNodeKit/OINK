// SPDX-FileCopyrightText: 2026 OpenIRLNodeKit contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
import { beforeEach, describe, expect, it } from 'vitest';
import {
  IRL_SERVER_PLAYER_BASE_URL,
  DEFAULT_IRL_SERVER_PLAYER_CONFIG,
  buildIRLServerPlayerUrl,
  loadIRLServerPlayerConfig,
  saveIRLServerPlayerConfig,
} from './irlServerPlayer';

describe('buildIRLServerPlayerUrl', () => {
  it('emits only the channel and showLogo=false by default', () => {
    const url = buildIRLServerPlayerUrl(
      'my_stream',
      DEFAULT_IRL_SERVER_PLAYER_CONFIG,
    );
    expect(url.startsWith(`${IRL_SERVER_PLAYER_BASE_URL}?`)).toBe(true);
    const params = new URLSearchParams(url.split('?')[1]);
    expect(params.get('channelName')).toBe('my_stream');
    expect(params.get('days')).toBeNull();
    expect(params.get('views')).toBeNull();
    expect(params.get('shuffle')).toBeNull();
    expect(params.get('volume')).toBeNull();
    expect(params.get('infoScale')).toBeNull();
    expect(params.get('showInfo')).toBeNull();
    expect(params.get('showLogo')).toBe('false');
    expect(params.get('showTimer')).toBeNull();
  });

  it('emits non-default clip filter values', () => {
    const url = buildIRLServerPlayerUrl('my_stream', {
      ...DEFAULT_IRL_SERVER_PLAYER_CONFIG,
      days: 7,
      minViews: 500,
      shuffle: 'stratified',
    });
    const params = new URLSearchParams(url.split('?')[1]);
    expect(params.get('days')).toBe('7');
    expect(params.get('views')).toBe('500');
    expect(params.get('shuffle')).toBe('stratified');
  });

  it('emits volume converted from percent to 0-1', () => {
    const url = buildIRLServerPlayerUrl('my_stream', {
      ...DEFAULT_IRL_SERVER_PLAYER_CONFIG,
      volumePercent: 80,
    });
    const params = new URLSearchParams(url.split('?')[1]);
    expect(params.get('volume')).toBe('0.8');
  });

  it('emits infoScale converted from percent when showInfo is on', () => {
    const url = buildIRLServerPlayerUrl('my_stream', {
      ...DEFAULT_IRL_SERVER_PLAYER_CONFIG,
      infoScalePercent: 150,
    });
    const params = new URLSearchParams(url.split('?')[1]);
    expect(params.get('infoScale')).toBe('1.5');
  });

  it('omits infoScale when showInfo is off', () => {
    const url = buildIRLServerPlayerUrl('my_stream', {
      ...DEFAULT_IRL_SERVER_PLAYER_CONFIG,
      showInfo: false,
      infoScalePercent: 150,
    });
    const params = new URLSearchParams(url.split('?')[1]);
    expect(params.get('showInfo')).toBe('false');
    expect(params.get('infoScale')).toBeNull();
  });

  it('always emits showLogo=false and showTimer when enabled', () => {
    const url = buildIRLServerPlayerUrl('my_stream', {
      ...DEFAULT_IRL_SERVER_PLAYER_CONFIG,
      showTimer: true,
    });
    const params = new URLSearchParams(url.split('?')[1]);
    expect(params.get('showLogo')).toBe('false');
    expect(params.get('showTimer')).toBe('true');
  });

  it('URL-encodes special characters in the channel', () => {
    const url = buildIRLServerPlayerUrl(
      'user two&more',
      DEFAULT_IRL_SERVER_PLAYER_CONFIG,
    );
    expect(url).toContain('channelName=user+two%26more');
  });
});

describe('loadIRLServerPlayerConfig', () => {
  beforeEach(() => localStorage.clear());

  it('returns defaults when nothing is stored', () => {
    expect(loadIRLServerPlayerConfig()).toEqual(
      DEFAULT_IRL_SERVER_PLAYER_CONFIG,
    );
  });

  it('merges stored config over defaults', () => {
    saveIRLServerPlayerConfig({
      ...DEFAULT_IRL_SERVER_PLAYER_CONFIG,
      days: 30,
      showTimer: true,
    });
    const cfg = loadIRLServerPlayerConfig();
    expect(cfg.days).toBe(30);
    expect(cfg.showTimer).toBe(true);
    expect(cfg.minViews).toBe(0);
  });
});
