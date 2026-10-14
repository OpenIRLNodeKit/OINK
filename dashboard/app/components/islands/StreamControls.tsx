'use client';
// SPDX-FileCopyrightText: 2026 OpenIRLNodeKit contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  getObsRecordStatus,
  getObsStreamStatus,
  startObsRecord,
  startObsStream,
  stopObsRecord,
  stopObsStream,
} from '../../lib/api';
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
  const value = bytes / 1024 ** i;
  return `${value.toFixed(value >= 10 || i === 0 ? 0 : 1)} ${units[i]}`;
}

type Output = 'stream' | 'record';

export default function StreamControls() {
  const [streamActive, setStreamActive] = useState<boolean | null>(null);
  const [recordActive, setRecordActive] = useState<boolean | null>(null);
  const [streamStats, setStreamStats] = useState({
    timecode: '',
    duration: 0,
    bytes: 0,
  });
  const [recordStats, setRecordStats] = useState({
    timecode: '',
    duration: 0,
    bytes: 0,
  });
  const [pending, setPending] = useState<Output | null>(null);
  const [error, setError] = useState<string | null>(null);
  const polling = useRef<ReturnType<typeof setInterval> | null>(null);

  const checkStatus = useCallback(async () => {
    const [stream, record] = await Promise.allSettled([
      getObsStreamStatus(),
      getObsRecordStatus(),
    ]);
    if (stream.status === 'fulfilled') {
      setStreamActive(stream.value.outputActive);
      setStreamStats({
        timecode: stream.value.outputTimecode,
        duration: stream.value.outputDuration,
        bytes: stream.value.outputBytes,
      });
    } else {
      setStreamActive(null);
    }
    if (record.status === 'fulfilled') {
      setRecordActive(record.value.outputActive);
      setRecordStats({
        timecode: record.value.outputTimecode,
        duration: record.value.outputDuration,
        bytes: record.value.outputBytes,
      });
    } else {
      setRecordActive(null);
    }
  }, []);

  useEffect(() => {
    void checkStatus();
    polling.current = setInterval(() => void checkStatus(), 2500);
    return () => {
      if (polling.current) clearInterval(polling.current);
    };
  }, [checkStatus]);

  const toggle = async (output: Output) => {
    const isActive = output === 'stream' ? streamActive : recordActive;
    if (isActive === null) return;
    setPending(output);
    setError(null);
    try {
      if (output === 'stream') {
        await (isActive ? stopObsStream() : startObsStream());
        setStreamActive(!isActive);
      } else {
        await (isActive ? stopObsRecord() : startObsRecord());
        setRecordActive(!isActive);
      }
      // Don't re-read status immediately: OBS reports the previous output state
      // for a moment after StopRecord, which would flip the toggle back until
      // the next poll. The 2.5s interval reconciles.
    } catch (e) {
      const fallback = `${isActive ? 'stop' : 'start'} ${
        output === 'stream' ? 'stream' : 'recording'
      }`;
      setError(e instanceof Error ? e.message : `Failed to ${fallback}`);
    } finally {
      setPending(null);
    }
  };

  return (
    <div className="flex flex-col items-end gap-1.5">
      <div className="flex gap-3 items-center">
        <Button
          variant={streamActive ? 'danger' : 'success'}
          aria-pressed={streamActive === true}
          onClick={() => toggle('stream')}
          disabled={pending !== null || streamActive === null}
        >
          {pending === 'stream'
            ? '…'
            : streamActive
              ? 'Stop Stream'
              : 'Start Stream'}
        </Button>
        <Button
          variant={recordActive ? 'danger' : 'success'}
          aria-pressed={recordActive === true}
          onClick={() => toggle('record')}
          disabled={pending !== null || recordActive === null}
        >
          {pending === 'record'
            ? '…'
            : recordActive
              ? 'Stop Recording'
              : 'Start Recording'}
        </Button>
      </div>
      <p className="text-xs tabular text-text-secondary">
        {streamActive === null
          ? 'Status unavailable'
          : streamActive
            ? `LIVE · ${streamStats.timecode || formatDuration(streamStats.duration)} · ${formatBytes(streamStats.bytes)}`
            : 'Offline'}
        {recordActive &&
          ` · REC · ${recordStats.timecode || formatDuration(recordStats.duration)} · ${formatBytes(recordStats.bytes)}`}
      </p>
      {error && <span className="text-xs text-danger">{error}</span>}
    </div>
  );
}
