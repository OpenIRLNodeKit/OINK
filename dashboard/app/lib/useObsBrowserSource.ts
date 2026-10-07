// SPDX-FileCopyrightText: 2026 OpenIRLNodeKit contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
import { useCallback, useState } from 'react';
import {
  deleteObsBrowserSource,
  provisionObsBrowserSource,
} from './api';
import { copyText } from './copy';

export interface ObsStatus {
  status: 'idle' | 'ok' | 'error';
  message: string;
}

export interface ObsBrowserSource {
  scenes: string[];
  toggleScene: (scene: string) => void;
  copyState: 'idle' | 'copied';
  handleCopy: () => Promise<void>;
  obsStatus: ObsStatus;
  handleApply: () => Promise<void>;
  handleRemove: () => Promise<void>;
}

export function useObsBrowserSource({
  url,
  widgetName,
  rerouteAudio,
}: {
  url: string;
  widgetName: string;
  rerouteAudio?: boolean;
}): ObsBrowserSource {
  const [scenes, setScenes] = useState<string[]>(['brb', 'low-br']);
  const [copyState, setCopyState] = useState<'idle' | 'copied'>('idle');
  const [obsStatus, setObsStatus] = useState<ObsStatus>({
    status: 'idle',
    message: '',
  });

  const toggleScene = useCallback((scene: string) => {
    setScenes((prev) =>
      prev.includes(scene) ? prev.filter((s) => s !== scene) : [...prev, scene],
    );
  }, []);

  const handleCopy = useCallback(async () => {
    const ok = await copyText(url);
    if (!ok) return;
    setCopyState('copied');
    setTimeout(() => setCopyState('idle'), 2000);
  }, [url]);

  const handleApply = useCallback(async () => {
    setObsStatus({ status: 'idle', message: '' });
    try {
      await provisionObsBrowserSource(
        widgetName,
        url,
        scenes,
        ...(rerouteAudio === undefined ? [] : [rerouteAudio]),
      );
      setObsStatus({
        status: 'ok',
        message: `Added "${widgetName}" browser source to: ${scenes.join(', ') || 'none'}`,
      });
    } catch (e) {
      const detail = e instanceof Error && e.message ? `: ${e.message}` : '';
      setObsStatus({
        status: 'error',
        message: `Failed to add browser source${detail}`,
      });
    }
  }, [widgetName, url, scenes, rerouteAudio]);

  const handleRemove = useCallback(async () => {
    setObsStatus({ status: 'idle', message: '' });
    try {
      await deleteObsBrowserSource(widgetName);
      setObsStatus({
        status: 'ok',
        message: `Removed "${widgetName}" browser source from OBS`,
      });
    } catch (e) {
      const detail = e instanceof Error && e.message ? `: ${e.message}` : '';
      setObsStatus({
        status: 'error',
        message: `Failed to remove browser source${detail}`,
      });
    }
  }, [widgetName]);

  return {
    scenes,
    toggleScene,
    copyState,
    handleCopy,
    obsStatus,
    handleApply,
    handleRemove,
  };
}
