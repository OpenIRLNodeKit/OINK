// SPDX-FileCopyrightText: 2026 OpenIRLNodeKit contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it, beforeEach } from 'vitest';
import {
  DEFAULT_JST_CHAT_CONFIG,
  JST_CHAT_BASE_URL,
  buildJstChatUrl,
  loadJstChatConfig,
} from './jstChat';

describe('buildJstChatUrl', () => {
  it('builds a URL with the channel and default 30s fade by default', () => {
    const url = buildJstChatUrl('castle_', DEFAULT_JST_CHAT_CONFIG);
    expect(url.startsWith(`${JST_CHAT_BASE_URL}?`)).toBe(true);
    expect(url).toContain('channel=castle_');
    expect(url).toContain('fade_after=30');
  });

  it('URL-encodes special characters in the channel', () => {
    const url = buildJstChatUrl('user two&more', DEFAULT_JST_CHAT_CONFIG);
    expect(url).toContain('channel=user+two%26more');
  });

  it('omits options that match the overlay defaults', () => {
    const url = buildJstChatUrl('castle_', DEFAULT_JST_CHAT_CONFIG);
    expect(url).not.toContain('shadow');
    expect(url).not.toContain('highlight_first_time');
    expect(url).not.toContain('shared_chat_badge');
    expect(url).not.toContain('hide_bots');
    expect(url).not.toContain('hide_commands');
    expect(url).not.toContain('hide=');
  });

  it('omits fade_after when fade is 0 (permanent)', () => {
    const url = buildJstChatUrl('castle_', {
      ...DEFAULT_JST_CHAT_CONFIG,
      fadeAfter: '0',
    });
    expect(url).not.toContain('fade_after');
  });

  it('appends fade_after in seconds when set', () => {
    const url = buildJstChatUrl('castle_', {
      ...DEFAULT_JST_CHAT_CONFIG,
      fadeAfter: '45',
    });
    expect(url).toContain('fade_after=45');
  });

  it('emits shadow=false when shadows are disabled', () => {
    const url = buildJstChatUrl('castle_', {
      ...DEFAULT_JST_CHAT_CONFIG,
      showShadow: false,
    });
    expect(url).toContain('shadow=false');
  });

  it('emits highlight_first_time and hide_commands when enabled', () => {
    const url = buildJstChatUrl('castle_', {
      ...DEFAULT_JST_CHAT_CONFIG,
      highlightFirstTime: true,
      hideCommands: true,
    });
    expect(url).toContain('highlight_first_time=true');
    expect(url).toContain('hide_commands=true');
  });

  it('emits hide_bots=false when bots are not hidden', () => {
    const url = buildJstChatUrl('castle_', {
      ...DEFAULT_JST_CHAT_CONFIG,
      hideBots: false,
    });
    expect(url).toContain('hide_bots=false');
  });

  it('emits shared_chat_badge and self_shared_badge for profile mode', () => {
    const url = buildJstChatUrl('castle_', {
      ...DEFAULT_JST_CHAT_CONFIG,
      sharedChatBadge: 'profile',
      selfSharedBadge: true,
    });
    expect(url).toContain('shared_chat_badge=profile');
    expect(url).toContain('self_shared_badge=true');
  });

  it('emits hide list with spaces stripped for the ignore list', () => {
    const url = buildJstChatUrl('castle_', {
      ...DEFAULT_JST_CHAT_CONFIG,
      ignoreList: 'nightbot, streamelements',
    });
    expect(url).toContain('hide=nightbot,streamelements');
  });
});

describe('loadJstChatConfig', () => {
  beforeEach(() => localStorage.clear());

  it('returns defaults when nothing is stored', () => {
    expect(loadJstChatConfig()).toEqual(DEFAULT_JST_CHAT_CONFIG);
  });

  it('merges stored config over defaults', () => {
    localStorage.setItem(
      'oink_jst_chat_config',
      JSON.stringify({ showShadow: false, hideCommands: true }),
    );
    const cfg = loadJstChatConfig();
    expect(cfg.showShadow).toBe(false);
    expect(cfg.hideCommands).toBe(true);
  });

  it('merges stored chat options over defaults', () => {
    localStorage.setItem(
      'oink_jst_chat_config',
      JSON.stringify({ showShadow: false, fadeAfter: '45', hideCommands: true }),
    );
    const cfg = loadJstChatConfig();
    expect(cfg.showShadow).toBe(false);
    expect(cfg.fadeAfter).toBe('45');
    expect(cfg.hideCommands).toBe(true);
  });
});
