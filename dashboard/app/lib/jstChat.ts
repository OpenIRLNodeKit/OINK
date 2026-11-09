// SPDX-FileCopyrightText: 2026 OpenIRLNodeKit contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
export const JST_CHAT_BASE_URL = 'https://itsalviiin.github.io/JstChat2/#/chat';
const JST_CHAT_STORAGE_KEY = 'oink_jst_chat_config';

export const JST_CHAT_SCENES = ['main', 'brb', 'privacy', 'offline', 'low-br'] as const;

export type SharedChatBadge = 'off' | 'simple' | 'profile';

export interface JstChatOptions {
  showShadow: boolean;
  fadeAfter: string;
  highlightFirstTime: boolean;
  sharedChatBadge: SharedChatBadge;
  selfSharedBadge: boolean;
  hideBots: boolean;
  hideCommands: boolean;
  ignoreList: string;
}

export const DEFAULT_JST_CHAT_CONFIG: JstChatOptions = {
  showShadow: true,
  fadeAfter: '30',
  highlightFirstTime: false,
  sharedChatBadge: 'off',
  selfSharedBadge: false,
  hideBots: true,
  hideCommands: false,
  ignoreList: '',
};

export type JstChatConfig = JstChatOptions;

export function buildJstChatUrl(
  channel: string,
  config: JstChatConfig,
): string {
  const options = { ...DEFAULT_JST_CHAT_CONFIG, ...config };
  const params = new URLSearchParams();
  params.set('channel', channel);
  const parts: string[] = [params.toString()];
  if (!options.showShadow) parts.push('shadow=false');
  if (options.fadeAfter.trim() && options.fadeAfter.trim() !== '0') {
    parts.push(`fade_after=${encodeURIComponent(options.fadeAfter.trim())}`);
  }
  if (options.highlightFirstTime) parts.push('highlight_first_time=true');
  if (options.sharedChatBadge !== 'off') {
    parts.push(`shared_chat_badge=${options.sharedChatBadge}`);
    if (options.selfSharedBadge) parts.push('self_shared_badge=true');
  }
  if (!options.hideBots) parts.push('hide_bots=false');
  if (options.hideCommands) parts.push('hide_commands=true');
  if (options.ignoreList.trim()) {
    parts.push(`hide=${options.ignoreList.replace(/\s+/g, '')}`);
  }
  return `${JST_CHAT_BASE_URL}?${parts.join('&')}`;
}

export function loadJstChatConfig(): JstChatConfig {
  try {
    const raw = localStorage.getItem(JST_CHAT_STORAGE_KEY);
    if (!raw) return { ...DEFAULT_JST_CHAT_CONFIG };
    const parsed = JSON.parse(raw) as Partial<JstChatConfig>;
    return { ...DEFAULT_JST_CHAT_CONFIG, ...parsed };
  } catch {
    return { ...DEFAULT_JST_CHAT_CONFIG };
  }
}

export function saveJstChatConfig(config: JstChatConfig): void {
  localStorage.setItem(JST_CHAT_STORAGE_KEY, JSON.stringify(config));
}
