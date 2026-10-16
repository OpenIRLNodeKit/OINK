"use client";
// SPDX-FileCopyrightText: 2026 OpenIRLNodeKit contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useCallback, useEffect, useState } from 'react';
import {
  getNoalbsConfig,
  getNoalbsEnv,
  saveNoalbsConfig,
  saveNoalbsEnv,
} from '../../lib/api';
import type { NoalbsConfig } from '../../lib/types';
import { Button, Field, Input, Toggle } from '../ui';

type SaveState = 'idle' | 'saving' | 'saved' | 'error';

const ENV_LINE = /^(\s*)([A-Za-z_][A-Za-z0-9_]*)(\s*=\s*)(.*)$/;

// Read a KEY=VALUE from dotenv text. Returns '' when absent.
function readEnvVar(text: string, key: string): string {
  for (const line of text.split('\n')) {
    const m = line.match(ENV_LINE);
    if (m && m[2] === key) return m[4];
  }
  return '';
}

// Upsert a KEY=VALUE line in dotenv text, appending if absent.
function setEnvVar(text: string, key: string, value: string): string {
  const lines = text.split('\n');
  let found = false;
  const out = lines.map((line) => {
    const m = line.match(ENV_LINE);
    if (m && m[2] === key) {
      found = true;
      return m[1] + key + m[3] + value;
    }
    return line;
  });
  if (!found) out.push(`${key}=${value}`);
  return out.join('\n');
}

export default function SwitcherConfigForm() {
  const [config, setConfig] = useState<NoalbsConfig | null>(null);
  const [enabled, setEnabled] = useState(true);
  const [low, setLow] = useState('900');
  const [offline, setOffline] = useState('300');
  const [admins, setAdmins] = useState('');
  const [envText, setEnvText] = useState('');
  const [username, setUsername] = useState('');
  const [oauth, setOauth] = useState('');
  const [oauthSet, setOauthSet] = useState(false);
  const [showOauth, setShowOauth] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saveState, setSaveState] = useState<SaveState>('idle');
  const [saveError, setSaveError] = useState<string | null>(null);

  const loadConfig = useCallback(async () => {
    try {
      const [cfg, env] = await Promise.all([
        getNoalbsConfig(),
        // .env may not exist yet (created on first save); treat as empty.
        getNoalbsEnv().catch(() => ''),
      ]);
      setConfig(cfg);
      setEnabled(cfg.switcher?.bitrateSwitcherEnabled ?? true);
      setLow(String(cfg.switcher?.triggers?.low ?? 900));
      setOffline(String(cfg.switcher?.triggers?.offline ?? 300));
      setAdmins((cfg.chat?.admins ?? []).join(', '));
      setEnvText(env);
      setUsername(readEnvVar(env, 'TWITCH_BOT_USERNAME'));
      // The oauth comes back redacted; never prefill it, just note it's set.
      setOauth('');
      setOauthSet(readEnvVar(env, 'TWITCH_BOT_OAUTH') !== '');
      setLoadError(null);
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : 'Failed to load config');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadConfig();
  }, [loadConfig]);

  const handleSave = async () => {
    setSaveState('saving');
    setSaveError(null);
    try {
      const cfg: NoalbsConfig = config ? structuredClone(config) : {};
      cfg.switcher = {
        ...cfg.switcher,
        bitrateSwitcherEnabled: enabled,
        triggers: {
          low: Math.max(0, Number(low) || 0),
          offline: Math.max(0, Number(offline) || 0),
        },
      };
      const adminList = admins
        .split(/[\n,]+/)
        .map((s) => s.trim())
        .filter(Boolean);
      cfg.chat = { ...cfg.chat, admins: adminList };
      await saveNoalbsConfig(cfg);

      // Bot creds go to noalbs/.env. Only rewrite the oauth line when a new token
      // was typed; otherwise the redacted placeholder round-trips and the server
      // restores the real value from disk.
      let env = envText;
      env = setEnvVar(env, 'TWITCH_BOT_USERNAME', username.trim());
      if (oauth.trim()) env = setEnvVar(env, 'TWITCH_BOT_OAUTH', oauth.trim());
      if (env.trim()) await saveNoalbsEnv(env);

      setConfig(cfg);
      setEnvText(env);
      setOauth('');
      setOauthSet(oauthSet || !!oauth.trim());
      setSaveState('saved');
    } catch (e) {
      setSaveState('error');
      setSaveError(e instanceof Error ? e.message : 'Failed to save config');
    }
  };

  const showToast = saveState === 'saved' || saveState === 'error';

  return (
    <div className="space-y-4">
      <Toggle
        name="auto-switch-toggle"
        label="Enable Auto Switching"
        description="Automatically switch scenes based on bitrate"
        checked={enabled}
        onChange={(e) => setEnabled(e.target.checked)}
        disabled={loading}
      />

      <div className="grid grid-cols-2 gap-4">
        <Field
          label="Low Bitrate Threshold"
          htmlFor="low-threshold"
          hint="kbps"
        >
          <Input
            id="low-threshold"
            type="number"
            min={0}
            value={low}
            onChange={(e) => setLow(e.target.value)}
            disabled={loading}
          />
        </Field>
        <Field
          label="Offline Threshold"
          htmlFor="offline-threshold"
          hint="kbps"
        >
          <Input
            id="offline-threshold"
            type="number"
            min={0}
            value={offline}
            onChange={(e) => setOffline(e.target.value)}
            disabled={loading}
          />
        </Field>
      </div>

      <div className="border-t border-border-subtle" />

      <div className="space-y-4">
        <div>
          <h3 className="text-sm font-semibold text-text-primary">Twitch Bot</h3>
          <p className="mt-0.5 text-[13px] leading-relaxed text-text-secondary">
            Account NOALBS uses to read and write chat.{' '}
            <a
              href="https://github.com/NOALBS/nginx-obs-automatic-low-bitrate-switching#chat-commands"
              target="_blank"
              rel="noopener noreferrer"
              className="text-primary underline hover:no-underline"
            >
              Chat commands
            </a>
          </p>
        </div>

        <Field
          label="Bot username"
          htmlFor="bot-username"
          hint="The Twitch account NOALBS logs in as"
        >
          <Input
            id="bot-username"
            name="bot-username"
            autoComplete="off"
            spellCheck={false}
            placeholder="my_bot"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            disabled={loading}
          />
        </Field>

        <Field
          label="Bot OAuth token"
          htmlFor="bot-oauth"
          hint={
            oauthSet
              ? 'Currently set — leave empty to keep'
              : 'oauth:<token> from twitchapps.com/tmi'
          }
        >
          <div className="relative">
            <Input
              id="bot-oauth"
              name="bot-oauth"
              type={showOauth ? 'text' : 'password'}
              autoComplete="off"
              spellCheck={false}
              placeholder={oauthSet ? '•••••••• (unchanged)' : 'oauth:…'}
              value={oauth}
              onChange={(e) => setOauth(e.target.value)}
              disabled={loading}
              className="pr-16"
            />
            <button
              type="button"
              aria-label={`${showOauth ? 'Hide' : 'Show'} bot OAuth token`}
              onClick={() => setShowOauth((v) => !v)}
              disabled={loading}
              className="absolute inset-y-0 right-0 px-3 text-xs font-medium text-text-secondary transition-colors hover:text-primary disabled:opacity-50"
            >
              {showOauth ? 'Hide' : 'Show'}
            </button>
          </div>
        </Field>

        <Field
          label="Mods / Admins"
          htmlFor="bot-admins"
          hint="Twitch usernames allowed to run switcher commands, comma-separated"
        >
          <Input
            id="bot-admins"
            name="bot-admins"
            autoComplete="off"
            spellCheck={false}
            placeholder="mod1, mod2"
            value={admins}
            onChange={(e) => setAdmins(e.target.value)}
            disabled={loading}
          />
        </Field>
      </div>

      <div className="flex items-center gap-3">
        <Button
          onClick={handleSave}
          disabled={loading || saveState === 'saving'}
        >
          {saveState === 'saving' ? 'Saving…' : 'Save'}
        </Button>
        <div
          role="status"
          className={`whitespace-nowrap px-3 py-1.5 rounded-lg text-sm font-medium transition-opacity duration-300 ${
            showToast
              ? 'opacity-100 ' +
                (
                  saveState === 'saved'
                    ? 'bg-success-soft text-success'
                    : 'bg-danger-soft text-danger'
                )
              : 'opacity-0'
          }`}
        >
          {saveState === 'saved' ? 'Saved' : saveError}
        </div>
      </div>

      {loading && (
        <p className="text-sm text-text-secondary">Loading configuration…</p>
      )}
      {loadError && (
        <p className="text-sm text-danger" role="alert">
          Failed to load config: {loadError}
        </p>
      )}
    </div>
  );
}
