"use client";
// SPDX-FileCopyrightText: 2026 OpenIRLNodeKit contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useChannel } from '../../lib/useChannel';
import {
  DEFAULT_JST_CHAT_CONFIG,
  type JstChatConfig,
  type SharedChatBadge,
  JST_CHAT_SCENES,
  buildJstChatUrl,
  loadJstChatConfig,
  saveJstChatConfig,
} from '../../lib/jstChat';
import { useObsBrowserSource } from '../../lib/useObsBrowserSource';
import { Field, Input, Select, Toggle } from '../ui';
import OverlayFormShell from './OverlayFormShell';

const WIDGET_NAME = 'twitch_chat';

export default function JstChatForm() {
  const [config, setConfig] = useState<JstChatConfig>(
    DEFAULT_JST_CHAT_CONFIG,
  );
  const { channel } = useChannel();
  const [hydrated, setHydrated] = useState(false);

  useEffect(() => {
    setConfig(loadJstChatConfig());
    setHydrated(true);
  }, []);

  useEffect(() => {
    if (!hydrated) return;
    saveJstChatConfig(config);
  }, [config, hydrated]);

  const url = useMemo(() => buildJstChatUrl(channel, config), [channel, config]);

  const channelMissing = !channel;

  const form = useObsBrowserSource({ url, widgetName: WIDGET_NAME, rerouteAudio: false });

  const update = useCallback(<K extends keyof JstChatConfig>(
    key: K,
    value: JstChatConfig[K],
  ) => {
    setConfig((prev) => ({ ...prev, [key]: value }));
  }, []);

  return (
    <OverlayFormShell
      url={url}
      canApply={!channelMissing}
      missingText="Set your channel name in Settings → Stream Settings to apply."
      sceneOptions={JST_CHAT_SCENES}
      showUrlField
      urlFieldId="jst-url"
      form={form}
    >
      <div className="space-y-4">
        <div className="flex items-center justify-between gap-3">
          <h4 className="text-sm font-semibold text-text-primary">Source</h4>
          <a
            href="https://itsalviiin.github.io/JstChat2/#/"
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1 rounded-control bg-bg-card px-2.5 py-1 text-xs font-medium text-text-primary ring-1 ring-inset ring-border-subtle transition-colors hover:bg-bg-elevated hover:ring-border"
          >
            JstChat2 ↗
          </a>
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
        <p className="text-[13px] text-text-secondary">
          The chat channel comes from Settings → Stream Settings. Chat is
          silent (audio not routed to OBS).
        </p>
      </div>

      <div className="space-y-3">
        <h4 className="text-sm font-semibold text-text-primary">Chat options</h4>
        <p className="text-[13px] text-text-secondary">
          Appearance and chat filtering for the overlay.
        </p>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Toggle
            name="chat-shadow"
            label="Shadows"
            checked={config.showShadow}
            onChange={() => update('showShadow', !config.showShadow)}
          />
          <Toggle
            name="chat-highlight-first"
            label="Highlight first messages"
            checked={config.highlightFirstTime}
            onChange={() =>
              update('highlightFirstTime', !config.highlightFirstTime)
            }
          />
          <Toggle
            name="chat-hide-bots"
            label="Hide bots"
            checked={config.hideBots}
            onChange={() => update('hideBots', !config.hideBots)}
          />
          <Toggle
            name="chat-hide-commands"
            label="Hide commands"
            checked={config.hideCommands}
            onChange={() => update('hideCommands', !config.hideCommands)}
          />
        </div>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Field
            label="Fade messages"
            htmlFor="jst-fadeAfter"
            hint="Seconds before a message fades (0 = permanent)"
          >
            <Input
              id="jst-fadeAfter"
              name="fadeAfter"
              type="number"
              min="0"
              step="5"
              value={config.fadeAfter}
              onChange={(e) => update('fadeAfter', e.target.value)}
            />
          </Field>
          <Field
            label="Shared chat badge"
            htmlFor="jst-sharedBadge"
            hint="Badge for messages from shared chats"
          >
            <Select
              id="jst-sharedBadge"
              name="sharedChatBadge"
              value={config.sharedChatBadge}
              onChange={(e) =>
                update('sharedChatBadge', e.target.value as SharedChatBadge)
              }
            >
              <option value="off">Off</option>
              <option value="simple">Simple</option>
              <option value="profile">Profile Image</option>
            </Select>
          </Field>
        </div>
        {config.sharedChatBadge === 'profile' && (
          <Toggle
            name="chat-self-shared-badge"
            label="Display own channel profile image"
            checked={config.selfSharedBadge}
            onChange={() => update('selfSharedBadge', !config.selfSharedBadge)}
          />
        )}
        <Field
          label="Ignore list"
          htmlFor="jst-ignoreList"
          hint="Usernames separated by commas to hide from chat"
        >
          <Input
            id="jst-ignoreList"
            name="ignoreList"
            placeholder="nightbot, streamelements"
            value={config.ignoreList}
            onChange={(e) => update('ignoreList', e.target.value)}
          />
        </Field>
      </div>
    </OverlayFormShell>
  );
}
