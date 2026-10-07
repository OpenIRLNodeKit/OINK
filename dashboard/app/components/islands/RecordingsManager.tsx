"use client";
// SPDX-FileCopyrightText: 2026 OpenIRLNodeKit contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useCallback, useState } from 'react';
import type { RecordingFile } from '../../lib/api';
import {
  deleteRecording,
  listRecordings,
  recordingDownloadUrl,
  recordingThumbUrl,
  recordingUrl,
} from '../../lib/api';
import { formatBytes, formatDate } from '../../lib/format';
import { useIntervalPolling } from '../../lib/useIntervalPolling';

type Status = { type: 'ok' | 'error'; text: string } | null;

const REFRESH_MS = 10000;

export default function RecordingsManager() {
  const [recordings, setRecordings] = useState<RecordingFile[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [status, setStatus] = useState<Status>(null);
  const [playing, setPlaying] = useState<RecordingFile | null>(null);

  const refresh = useCallback(async () => {
    try {
      setRecordings(await listRecordings());
      setLoadError(null);
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : 'Failed to load recordings');
    } finally {
      setLoading(false);
      setLoadingMore(false);
    }
  }, []);

  const pollRefresh = useCallback(() => {
    setLoadingMore(true);
    return refresh();
  }, [refresh]);

  useIntervalPolling(pollRefresh, REFRESH_MS);

  const handleDelete = async (rec: RecordingFile) => {
    if (!window.confirm(`Delete "${rec.name}"?`)) return;
    setStatus(null);
    try {
      await deleteRecording(rec.name);
      setRecordings((prev) => prev.filter((r) => r.name !== rec.name));
      setStatus({ type: 'ok', text: `Deleted ${rec.name}` });
    } catch (e) {
      setStatus({
        type: 'error',
        text: `Failed to delete ${rec.name}: ${e instanceof Error ? e.message : 'unknown error'}`,
      });
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between px-1">
        <p
          className="text-sm text-text-secondary"
          data-testid="recording-count"
        >
          {loading
            ? 'Loading recordings…'
            : loadError
              ? 'Recording list unavailable'
              : `${recordings.length} recording${recordings.length === 1 ? '' : 's'} on this server`}
        </p>
        <button
          type="button"
          onClick={() => {
            setLoadingMore(true);
            void refresh();
          }}
          disabled={loadingMore}
          className="inline-flex items-center gap-1.5 rounded-control bg-bg-card px-3 py-1.5 text-xs font-medium text-text-primary ring-1 ring-inset ring-border-subtle transition-colors hover:bg-bg-elevated hover:ring-border disabled:opacity-60"
        >
          <svg
            aria-hidden="true"
            className="h-3.5 w-3.5"
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth="1.75"
              d="M16.023 9.348h4.992v-.001M2.985 19.644v-4.992m0 0h4.992m-4.993 0l3.181 3.183a8.25 8.25 0 0013.803-3.7M4.031 9.865a8.25 8.25 0 0113.803-3.7l3.181 3.182m0-4.991v4.99"
            />
          </svg>
          Refresh
        </button>
      </div>

      {loadError && !loading && (
        <p className="px-1 text-sm text-danger" role="alert">
          Failed to load recordings: {loadError}
        </p>
      )}

      {status && (
        <p
          role="status"
          className={`px-1 text-sm font-medium ${
            status.type === 'ok' ? 'text-success' : 'text-danger'
          }`}
        >
          {status.text}
        </p>
      )}

      {!loading && !loadError && recordings.length === 0 && (
        <p className="px-1 pb-4 text-sm text-text-faint">
          No recordings yet — start a recording in OBS and it will show up here.
        </p>
      )}

      {recordings.length > 0 && (
        <ul
          className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3"
          data-testid="recording-grid"
        >
          {recordings.map((rec) => (
            <li
              key={rec.name}
              className="surface overflow-hidden transition-colors hover:border-border"
            >
              <button
                type="button"
                onClick={() => setPlaying(rec)}
                aria-label={`Play ${rec.name}`}
                className="group relative block aspect-video w-full overflow-hidden bg-black"
              >
                <img
                  src={recordingThumbUrl(rec.name)}
                  alt=""
                  loading="lazy"
                  data-testid="recording-thumb"
                  className="h-full w-full object-cover"
                  onError={(e) => {
                    (e.currentTarget as HTMLImageElement).style.display = 'none';
                  }}
                />
                <span className="absolute inset-0 flex items-center justify-center bg-black/0 transition-colors group-hover:bg-black/30">
                  <span className="flex h-11 w-11 items-center justify-center rounded-full bg-white/20 text-white opacity-0 backdrop-blur-sm transition-opacity group-hover:opacity-100">
                    <svg
                      aria-hidden="true"
                      className="ml-0.5 h-5 w-5"
                      fill="currentColor"
                      viewBox="0 0 24 24"
                    >
                      <path d="M8 5.14v14l11-7-11-7z" />
                    </svg>
                  </span>
                </span>
              </button>

              <div className="flex items-center gap-2 px-3 py-2.5">
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium text-text-primary tabular" title={rec.name}>
                    {rec.name}
                  </p>
                  <p className="text-xs text-text-faint tabular">
                    {formatBytes(rec.size)} · {formatDate(rec.mtime)}
                  </p>
                </div>
                <a
                  href={recordingDownloadUrl(rec.name)}
                  download={rec.name}
                  aria-label={`Download ${rec.name}`}
                  title={`Download ${rec.name}`}
                  className="inline-flex h-8 w-8 items-center justify-center rounded-lg text-text-secondary transition-colors hover:bg-bg-elevated hover:text-text-primary"
                >
                  <svg
                    aria-hidden="true"
                    className="h-4 w-4"
                    fill="none"
                    viewBox="0 0 24 24"
                    stroke="currentColor"
                  >
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth="1.5"
                      d="M3 16.5v2.25A2.25 2.25 0 005.25 21h13.5A2.25 2.25 0 0021 18.75V16.5M16.5 12L12 16.5m0 0L7.5 12m4.5 4.5V3"
                    />
                  </svg>
                </a>
                <button
                  type="button"
                  aria-label={`Delete ${rec.name}`}
                  title={`Delete ${rec.name}`}
                  onClick={() => void handleDelete(rec)}
                  className="inline-flex h-8 w-8 items-center justify-center rounded-lg text-text-faint transition-colors hover:bg-danger-soft hover:text-danger"
                >
                  <svg
                    aria-hidden="true"
                    className="h-4 w-4"
                    fill="none"
                    viewBox="0 0 24 24"
                    stroke="currentColor"
                  >
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth="1.5"
                      d="M14.74 9l-.346 9m-4.788 0L9.26 9m9.968-3.21c.342.052.682.107 1.022.166m-1.022-.165L18.16 19.673a2.25 2.25 0 01-2.244 2.077H8.084a2.25 2.25 0 01-2.244-2.077L4.772 5.79m14.456 0a48.108 48.108 0 00-3.478-.397m-12 .562c.34-.059.68-.114 1.022-.165m0 0a48.11 48.11 0 013.478-.397m7.5 0v-.916c0-1.18-.91-2.164-2.09-2.201a51.964 51.964 0 00-3.32 0c-1.18.037-2.09 1.022-2.09 2.201v.916m7.5 0a48.667 48.667 0 00-7.5 0"
                    />
                  </svg>
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}

      {playing && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4"
          onClick={() => setPlaying(null)}
          data-testid="recording-player"
        >
          <div
            className="w-full max-w-3xl overflow-hidden rounded-card bg-bg-card shadow-2xl ring-1 ring-inset ring-border-subtle"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between gap-3 px-4 py-3">
              <p className="truncate text-sm font-semibold tracking-tight text-text-primary tabular">
                {playing.name}
              </p>
              <button
                type="button"
                aria-label="Close player"
                onClick={() => setPlaying(null)}
                className="inline-flex h-8 w-8 items-center justify-center rounded-lg text-text-faint transition-colors hover:bg-bg-elevated hover:text-text-primary"
              >
                <svg
                  aria-hidden="true"
                  className="h-4 w-4"
                  fill="none"
                  viewBox="0 0 24 24"
                  stroke="currentColor"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth="1.75"
                    d="M6 18L18 6M6 6l12 12"
                  />
                </svg>
              </button>
            </div>
            <video
              controls
              autoPlay
              src={recordingUrl(playing.name)}
              className="aspect-video w-full bg-black"
              data-testid="recording-video"
            />
          </div>
        </div>
      )}
    </div>
  );
}
