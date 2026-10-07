// SPDX-FileCopyrightText: 2026 OpenIRLNodeKit contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
export const IRL_SERVER_PLAYER_BASE_URL = 'https://clips.irl.ac/';
export const IRL_SERVER_PLAYER_STORAGE_KEY =
  'oink_irl_server_player_config';

export const IRL_SERVER_SHUFFLE_MODES = [
  'smart',
  'stratified',
  'weighted',
  'random',
] as const;
export type IRLServerShuffleMode = (typeof IRL_SERVER_SHUFFLE_MODES)[number];

export interface IRLServerPlayerConfig {
  days: number;
  minViews: number;
  shuffle: IRLServerShuffleMode;
  volumePercent: number;
  infoScalePercent: number;
  showInfo: boolean;
  showTimer: boolean;
}

export const DEFAULT_IRL_SERVER_PLAYER_CONFIG: IRLServerPlayerConfig = {
  days: 900,
  minViews: 0,
  shuffle: 'smart',
  volumePercent: 50,
  infoScalePercent: 100,
  showInfo: true,
  showTimer: false,
};

export function buildIRLServerPlayerUrl(
  channel: string,
  config: IRLServerPlayerConfig,
): string {
  const params = new URLSearchParams();
  params.set('channelName', channel);
  if (config.days !== 900) params.set('days', String(config.days));
  if (config.minViews !== 0) params.set('views', String(config.minViews));
  if (config.shuffle !== 'smart') params.set('shuffle', config.shuffle);
  if (config.volumePercent !== 50) {
    params.set('volume', String(config.volumePercent / 100));
  }
  if (!config.showInfo) params.set('showInfo', 'false');
  if (config.showInfo && config.infoScalePercent !== 100) {
    params.set('infoScale', String(config.infoScalePercent / 100));
  }
  params.set('showLogo', 'false');
  if (config.showTimer) params.set('showTimer', 'true');
  return `${IRL_SERVER_PLAYER_BASE_URL}?${params.toString()}`;
}

export function loadIRLServerPlayerConfig(): IRLServerPlayerConfig {
  const defaults = { ...DEFAULT_IRL_SERVER_PLAYER_CONFIG };
  try {
    let raw = localStorage.getItem(IRL_SERVER_PLAYER_STORAGE_KEY);
    if (!raw) return defaults;
    const parsed = JSON.parse(raw) as Partial<IRLServerPlayerConfig>;
    return { ...defaults, ...parsed };
  } catch {
    return defaults;
  }
}

export function saveIRLServerPlayerConfig(
  config: IRLServerPlayerConfig,
): void {
  localStorage.setItem(IRL_SERVER_PLAYER_STORAGE_KEY, JSON.stringify(config));
}
