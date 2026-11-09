// SPDX-FileCopyrightText: 2026 OpenIRLNodeKit contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
export const TWITCH_CLIPS_BASE_URL = 'https://twitchclipsplayer.com/clips.html';
const TWITCH_CLIPS_STORAGE_KEY = 'oink_twitch_clips_config';
const TWITCH_CLIPS_PROVIDER_KEY = 'oink_twitch_clips_provider';

export type TwitchClipsProvider = 'twitch-clips-player' | 'irlserver-player';

const DEFAULT_TWITCH_CLIPS_PROVIDER: TwitchClipsProvider =
  'twitch-clips-player';

export function loadTwitchClipsProvider(): TwitchClipsProvider {
  try {
    const raw = localStorage.getItem(TWITCH_CLIPS_PROVIDER_KEY);
    if (raw === 'twitch-clips-player' || raw === 'irlserver-player') {
      return raw;
    }
  } catch {
    // ignore malformed stored provider
  }
  return DEFAULT_TWITCH_CLIPS_PROVIDER;
}

export function saveTwitchClipsProvider(provider: TwitchClipsProvider): void {
  localStorage.setItem(TWITCH_CLIPS_PROVIDER_KEY, provider);
}

export const TWITCH_CLIPS_SCENES = ['main', 'brb', 'privacy', 'offline', 'low-br'] as const;

export const TWITCH_CLIPS_THEMES: Array<{ value: number; label: string }> = [
  { value: 1, label: 'None' },
  { value: 2, label: 'Slide in fancy skewed' },
  { value: 3, label: 'Slide in basic' },
  { value: 4, label: 'Outside the box' },
  { value: 5, label: 'Pink' },
  { value: 6, label: 'Comfortaa' },
  { value: 7, label: 'Cyber' },
  { value: 8, label: 'Orbitron' },
  { value: 9, label: 'Righteous' },
  { value: 10, label: '80s' },
  { value: 11, label: 'Comic Neue' },
  { value: 12, label: 'Terminal' },
  { value: 13, label: 'Slide Mega' },
  { value: 14, label: 'Retro' },
];

export interface TwitchClipsPlayerConfig {
  limit: number;
  dateRange: number;
  videoSize: string;
  themeOption: number;
  preferFeatured: boolean;
  showText: boolean;
  progressBar: boolean;
  profileBadge: boolean;
  showDetails: boolean;
  detailsText: string;
  delay: number;
}

export const DEFAULT_TWITCH_CLIPS_CONFIG: TwitchClipsPlayerConfig = {
  limit: 100,
  dateRange: 360,
  videoSize: '',
  themeOption: 2,
  preferFeatured: true,
  showText: false,
  progressBar: false,
  profileBadge: false,
  showDetails: false,
  detailsText: '',
  delay: 0,
};

export function buildTwitchClipsUrl(
  channel: string,
  config: TwitchClipsPlayerConfig,
): string {
  const params = new URLSearchParams();
  params.set('channel', channel);
  params.set('limit', String(config.limit));
  params.set('dateRange', String(config.dateRange));
  params.set('videoSize', config.videoSize);
  params.set('themeOption', String(config.themeOption));
  params.set('preferFeatured', String(config.preferFeatured));
  params.set('showText', String(config.showText));
  params.set('progressBar', String(config.progressBar));
  params.set('profileBadge', String(config.profileBadge));
  params.set('showDetails', String(config.showDetails));
  params.set('detailsText', config.detailsText);
  params.set('mainAccount', channel);
  params.set('delay', String(config.delay));
  params.set('cache', 'true');
  return `${TWITCH_CLIPS_BASE_URL}?${params.toString()}`;
}

export function loadTwitchClipsConfig(): TwitchClipsPlayerConfig {
  try {
    const raw = localStorage.getItem(TWITCH_CLIPS_STORAGE_KEY);
    if (!raw) return { ...DEFAULT_TWITCH_CLIPS_CONFIG };
    const parsed = JSON.parse(raw) as Partial<TwitchClipsPlayerConfig>;
    return { ...DEFAULT_TWITCH_CLIPS_CONFIG, ...parsed };
  } catch {
    return { ...DEFAULT_TWITCH_CLIPS_CONFIG };
  }
}

export function saveTwitchClipsConfig(config: TwitchClipsPlayerConfig): void {
  localStorage.setItem(TWITCH_CLIPS_STORAGE_KEY, JSON.stringify(config));
}
