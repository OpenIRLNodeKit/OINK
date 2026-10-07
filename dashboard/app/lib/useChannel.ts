// SPDX-FileCopyrightText: 2026 OpenIRLNodeKit contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
import { useCallback, useEffect, useRef, useState } from 'react';
import { getSettings, saveSettings } from './api';

const SAVE_DEBOUNCE_MS = 400;

/**
 * The Twitch channel name is a server setting (stack/dashboard.json) so every
 * browser/operator and the overlays see the same value. Edits are debounced
 * before the PUT so typing doesn't spam the API.
 */
export function useChannel() {
  const [channel, setChannelState] = useState('');
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pending = useRef<string | null>(null);

  const persist = useCallback((value: string) => {
    pending.current = null;
    saveSettings({ twitchChannel: value })
      .then((s) => setChannelState(s.twitchChannel))
      .catch(() => {});
  }, []);

  useEffect(() => {
    let live = true;
    getSettings()
      .then((s) => {
        if (live) setChannelState(s.twitchChannel);
      })
      .catch(() => {});
    return () => {
      live = false;
      // Flush a debounced edit so navigating away doesn't drop it.
      if (timer.current) clearTimeout(timer.current);
      if (pending.current !== null) persist(pending.current);
    };
  }, [persist]);

  const setChannel = useCallback(
    (value: string) => {
      setChannelState(value);
      pending.current = value;
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => {
        pending.current = null;
        persist(value);
      }, SAVE_DEBOUNCE_MS);
    },
    [persist],
  );

  return { channel, setChannel };
}
