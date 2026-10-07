"use client";
// SPDX-FileCopyrightText: 2026 OpenIRLNodeKit contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useCallback, useEffect, useRef, useState } from 'react';
import { getObsStreamStatus, startObsStream, stopObsStream } from '../../lib/api';
import { Button } from '../ui';

function formatDuration(ms: number): string {
  if (!ms || ms <= 0) return '0:00';
  const totalSeconds = Math.floor(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const mm = String(minutes).padStart(2, '0');
  const ss = String(seconds).padStart(2, '0');
  return hours > 0 ? `${hours}:${mm}:${ss}` : `${minutes}:${ss}`;
}

function formatBytes(bytes: number): string {
  if (!bytes || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  const i = Math.min(Math.floor(Math.log2(bytes) / 10), units.length - 1);
  const value = bytes / Math.pow(1024, i);
  return `${value.toFixed(value >= 10 || i === 0 ? 0 : 1)} ${units[i]}`;
}

export default function StreamControls() {
  const [active, setActive] = useState<boolean | null>(null);
  const [pending, setPending] = useState<'start' | 'stop' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [timecode, setTimecode] = useState('');
  const [duration, setDuration] = useState(0);
  const [bytes, setBytes] = useState(0);
  const polling = useRef<ReturnType<typeof setInterval> | null>(null);

  const checkStatus = useCallback(async () => {
    try {
      const status = await getObsStreamStatus();
      setActive(status.outputActive);
      setTimecode(status.outputTimecode);
      setDuration(status.outputDuration);
      setBytes(status.outputBytes);
    } catch {
      setActive(null);
    }
  }, []);

  useEffect(() => {
    void checkStatus();
    polling.current = setInterval(() => void checkStatus(), 2500);
    return () => {
      if (polling.current) clearInterval(polling.current);
    };
  }, [checkStatus]);

  const handleAction = async (action: 'start' | 'stop') => {
    setPending(action);
    setError(null);
    try {
      if (action === 'start') {
        await startObsStream();
      } else {
        await stopObsStream();
      }
      await checkStatus();
    } catch (e) {
      setError(e instanceof Error ? e.message : (action === 'start' ? 'Failed to start stream' : 'Failed to stop stream'));
    } finally {
      setPending(null);
    }
  };

  return (
    <div className="flex flex-col items-end gap-1.5">
      <div className="flex gap-3 items-center">
        <Button
          variant="success"
          onClick={() => handleAction('start')}
          disabled={active === null || active === true || pending !== null}
        >
          {pending === 'start' ? 'Starting…' : 'Start Stream'}
        </Button>
        <Button
          variant="danger"
          onClick={() => handleAction('stop')}
          disabled={active === null || active === false || pending !== null}
        >
          {pending === 'stop' ? 'Stopping…' : 'Stop Stream'}
        </Button>
      </div>
      <p className="text-xs tabular text-text-secondary">
        {active === null
          ? 'Status unavailable'
          : active
            ? `LIVE · ${timecode || formatDuration(duration)} · ${formatBytes(bytes)}`
            : 'Offline'}
      </p>
      {error && <span className="text-xs text-danger">{error}</span>}
    </div>
  );
}
