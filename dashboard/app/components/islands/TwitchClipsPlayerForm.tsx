"use client";
// SPDX-FileCopyrightText: 2026 OpenIRLNodeKit contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  DEFAULT_IRL_SERVER_PLAYER_CONFIG,
  type IRLServerPlayerConfig,
  type IRLServerShuffleMode,
  IRL_SERVER_SHUFFLE_MODES,
  IRL_SERVER_PLAYER_BASE_URL,
  buildIRLServerPlayerUrl,
  loadIRLServerPlayerConfig,
  saveIRLServerPlayerConfig,
} from '../../lib/irlServerPlayer';
import {
  DEFAULT_TWITCH_CLIPS_CONFIG,
  type TwitchClipsPlayerConfig,
  type TwitchClipsProvider,
  TWITCH_CLIPS_SCENES,
  TWITCH_CLIPS_THEMES,
  buildTwitchClipsUrl,
  loadTwitchClipsConfig,
  loadTwitchClipsProvider,
  saveTwitchClipsConfig,
  saveTwitchClipsProvider,
} from '../../lib/twitchClipsPlayer';
import { useChannel } from '../../lib/useChannel';
import { useObsBrowserSource } from '../../lib/useObsBrowserSource';
import { Button, Field, Input, Select, Toggle } from '../ui';
import OverlayFormShell from './OverlayFormShell';

const WIDGET_NAME = 'twitch_clips';

const PROVIDER_LINKS: Record<
  TwitchClipsProvider,
  { label: string; href: string }
> = {
  'twitch-clips-player': {
    label: 'Twitch Clips Player ↗',
    href: 'https://twitchclipsplayer.com/',
  },
  'irlserver-player': {
    label: 'IRLServer Player ↗',
    href: IRL_SERVER_PLAYER_BASE_URL,
  },
};

export default function TwitchClipsPlayerForm() {
  const [provider, setProvider] = useState<TwitchClipsProvider>(
    'twitch-clips-player',
  );
  const [config, setConfig] = useState<TwitchClipsPlayerConfig>(
    DEFAULT_TWITCH_CLIPS_CONFIG,
  );
  const [irlConfig, setIrlConfig] = useState<IRLServerPlayerConfig>(
    DEFAULT_IRL_SERVER_PLAYER_CONFIG,
  );
  const { channel } = useChannel();
  const [hydrated, setHydrated] = useState(false);

  useEffect(() => {
    setProvider(loadTwitchClipsProvider());
    setConfig(loadTwitchClipsConfig());
    setIrlConfig(loadIRLServerPlayerConfig());
    setHydrated(true);
  }, []);

  useEffect(() => {
    if (!hydrated) return;
    saveTwitchClipsProvider(provider);
  }, [provider, hydrated]);

  useEffect(() => {
    if (!hydrated) return;
    saveTwitchClipsConfig(config);
  }, [config, hydrated]);

  useEffect(() => {
    if (!hydrated) return;
    saveIRLServerPlayerConfig(irlConfig);
  }, [irlConfig, hydrated]);

  const url = useMemo(() => {
    if (provider === 'irlserver-player') {
      return buildIRLServerPlayerUrl(channel, irlConfig);
    }
    return buildTwitchClipsUrl(channel, config);
  }, [provider, channel, config, irlConfig]);

  const sourceLink = PROVIDER_LINKS[provider];
  const channelMissing = !channel;

  const form = useObsBrowserSource({ url, widgetName: WIDGET_NAME });

  const update = useCallback(<K extends keyof TwitchClipsPlayerConfig>(
    key: K,
    value: TwitchClipsPlayerConfig[K],
  ) => {
    setConfig((prev) => ({ ...prev, [key]: value }));
  }, []);

  const updateIrl = useCallback(<K extends keyof IRLServerPlayerConfig>(
    key: K,
    value: IRLServerPlayerConfig[K],
  ) => {
    setIrlConfig((prev) => ({ ...prev, [key]: value }));
  }, []);

  return (
    <OverlayFormShell
      url={url}
      canApply={!channelMissing}
      missingText="Set your channel name in Settings → Stream Settings to apply."
      sceneOptions={TWITCH_CLIPS_SCENES}
      showUrlField
      urlFieldId="twc-url"
      form={form}
    >
      <div className="space-y-4">
        <div className="flex items-center justify-between gap-3">
          <h4 className="text-sm font-semibold text-text-primary">Source</h4>
          <a
            href={sourceLink.href}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1 rounded-control bg-bg-card px-2.5 py-1 text-xs font-medium text-text-primary ring-1 ring-inset ring-border-subtle transition-colors hover:bg-bg-elevated hover:ring-border"
          >
            {sourceLink.label}
          </a>
        </div>
        <div
          className="grid grid-cols-2 gap-2"
          role="group"
          aria-label="Clip player"
        >
          <Button
            variant={provider === 'twitch-clips-player' ? 'primary' : 'secondary'}
            size="sm"
            onClick={() => setProvider('twitch-clips-player')}
            aria-pressed={provider === 'twitch-clips-player'}
          >
            Twitch Clips Player
          </Button>
          <Button
            variant={provider === 'irlserver-player' ? 'primary' : 'secondary'}
            size="sm"
            onClick={() => setProvider('irlserver-player')}
            aria-pressed={provider === 'irlserver-player'}
          >
            IRLServer Player
          </Button>
        </div>
        <div className="space-y-1.5">
          <p className="text-sm font-medium text-text-primary">
            Channel username
          </p>
          {channel ? (
            <p className="text-sm text-text-secondary">
              Uses <span className="font-medium text-text-primary">{channel}</span>{' '}
              from Settings → Stream Settings.
            </p>
          ) : (
            <p className="text-sm text-warning">
              Set your channel username in Settings → Stream Settings.
            </p>
          )}
        </div>
      </div>

      {provider === 'twitch-clips-player' ? (
        <>
          <div className="space-y-4">
            <h4 className="text-sm font-semibold text-text-primary">
              Clip Selection
            </h4>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              <Field label="Max clips" htmlFor="twc-limit" hint="Limit is 100">
                <Input
                  id="twc-limit"
                  name="limit"
                  type="number"
                  min={0}
                  max={100}
                  value={config.limit}
                  onChange={(e) => update('limit', Number(e.target.value))}
                />
              </Field>
              <Field
                label="Date range (days)"
                htmlFor="twc-dateRange"
                hint="0 = OFF"
              >
                <Input
                  id="twc-dateRange"
                  name="dateRange"
                  type="number"
                  min={0}
                  value={config.dateRange}
                  onChange={(e) => update('dateRange', Number(e.target.value))}
                />
              </Field>
              <Field label="Delay between clips (s)" htmlFor="twc-delay">
                <Input
                  id="twc-delay"
                  name="delay"
                  type="number"
                  min={0}
                  value={config.delay}
                  onChange={(e) => update('delay', Number(e.target.value))}
                />
              </Field>
            </div>
            <Toggle
              name="preferFeatured"
              label="Prefer featured clips"
              description="Falls back to popular clips if none match"
              checked={config.preferFeatured}
              onChange={(e) => update('preferFeatured', e.target.checked)}
            />
          </div>

          <div className="space-y-4">
            <h4 className="text-sm font-semibold text-text-primary">
              Appearance
            </h4>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <Field label="Theme" htmlFor="twc-themeOption">
                <Select
                  id="twc-themeOption"
                  name="themeOption"
                  value={String(config.themeOption)}
                  onChange={(e) =>
                    update('themeOption', Number(e.target.value))
                  }
                >
                  {TWITCH_CLIPS_THEMES.map((t) => (
                    <option key={t.value} value={t.value}>
                      {t.label}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field
                label="Force video size"
                htmlFor="twc-videoSize"
                hint="e.g. 1920x1080 (leave blank for full canvas)"
              >
                <Input
                  id="twc-videoSize"
                  name="videoSize"
                  placeholder="1920x1080"
                  value={config.videoSize}
                  onChange={(e) => update('videoSize', e.target.value)}
                />
              </Field>
            </div>
            <Toggle
              name="showText"
              label="Show channel name on top"
              checked={config.showText}
              onChange={(e) => update('showText', e.target.checked)}
            />
            <Toggle
              name="progressBar"
              label="Show progress bar"
              checked={config.progressBar}
              onChange={(e) => update('progressBar', e.target.checked)}
            />
            <Toggle
              name="profileBadge"
              label="Show profile badge"
              checked={config.profileBadge}
              onChange={(e) => update('profileBadge', e.target.checked)}
            />
            <Toggle
              name="showDetails"
              label="Show clip details panel"
              checked={config.showDetails}
              onChange={(e) => update('showDetails', e.target.checked)}
            />
            {config.showDetails && (
              <Field
                label="Details text"
                htmlFor="twc-detailsText"
                hint="Variables: {channel} {title} {game} {creator_name} {created_at}"
              >
                <Input
                  id="twc-detailsText"
                  name="detailsText"
                  placeholder="Now showing {title} by {creator_name}"
                  value={config.detailsText}
                  onChange={(e) => update('detailsText', e.target.value)}
                />
              </Field>
            )}
          </div>
        </>
      ) : (
        <>
          <div className="space-y-4">
            <h4 className="text-sm font-semibold text-text-primary">
              Clip Filters
            </h4>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              <Field
                label="Days"
                htmlFor="irl-days"
                hint="Filter clips from last N days"
              >
                <Input
                  id="irl-days"
                  name="days"
                  type="number"
                  min={1}
                  max={9999}
                  value={irlConfig.days}
                  onChange={(e) => updateIrl('days', Number(e.target.value))}
                />
              </Field>
              <Field
                label="Min views"
                htmlFor="irl-minViews"
                hint="0 = no minimum"
              >
                <Input
                  id="irl-minViews"
                  name="minViews"
                  type="number"
                  min={0}
                  value={irlConfig.minViews}
                  onChange={(e) => updateIrl('minViews', Number(e.target.value))}
                />
              </Field>
              <Field label="Shuffle Mode" htmlFor="irl-shuffle">
                <Select
                  id="irl-shuffle"
                  name="shuffle"
                  value={irlConfig.shuffle}
                  onChange={(e) =>
                    updateIrl('shuffle', e.target.value as IRLServerShuffleMode)
                  }
                >
                  {IRL_SERVER_SHUFFLE_MODES.map((mode) => (
                    <option key={mode} value={mode}>
                      {mode.charAt(0).toUpperCase() + mode.slice(1)}
                    </option>
                  ))}
                </Select>
              </Field>
            </div>
          </div>

          <div className="space-y-4">
            <h4 className="text-sm font-semibold text-text-primary">
              Playback
            </h4>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <Field
                label="Volume (%)"
                htmlFor="irl-volumePercent"
                hint="0–100"
              >
                <Input
                  id="irl-volumePercent"
                  name="volumePercent"
                  type="number"
                  min={0}
                  max={100}
                  value={irlConfig.volumePercent}
                  onChange={(e) =>
                    updateIrl('volumePercent', Number(e.target.value))
                  }
                />
              </Field>
              <Field
                label="Clip info size (%)"
                htmlFor="irl-infoScalePercent"
                hint="Scales the clip info overlay"
              >
                <Input
                  id="irl-infoScalePercent"
                  name="infoScalePercent"
                  type="number"
                  min={50}
                  max={250}
                  step={5}
                  disabled={!irlConfig.showInfo}
                  value={irlConfig.infoScalePercent}
                  onChange={(e) =>
                    updateIrl('infoScalePercent', Number(e.target.value))
                  }
                />
              </Field>
            </div>
            <Toggle
              name="showInfo"
              label="Show clip info"
              checked={irlConfig.showInfo}
              onChange={(e) => updateIrl('showInfo', e.target.checked)}
            />
            <Toggle
              name="showTimer"
              label="Show countdown timer"
              checked={irlConfig.showTimer}
              onChange={(e) => updateIrl('showTimer', e.target.checked)}
            />
          </div>
        </>
      )}
    </OverlayFormShell>
  );
}
