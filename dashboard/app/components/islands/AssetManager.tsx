"use client";
// SPDX-FileCopyrightText: 2026 OpenIRLNodeKit contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useCallback, useEffect, useRef, useState } from 'react';
import type { AssetFile } from '../../lib/api';
import { assetUrl, deleteAsset, listAssets, uploadAsset } from '../../lib/api';
import { formatBytes, formatDate } from '../../lib/format';

type Status = { type: 'ok' | 'error'; text: string } | null;

const IMAGE_EXT = new Set([
  'png',
  'jpg',
  'jpeg',
  'gif',
  'webp',
  'bmp',
  'avif',
  'svg',
]);

function isImage(name: string): boolean {
  const ext = name.split('.').pop()?.toLowerCase() ?? '';
  return IMAGE_EXT.has(ext);
}

export default function AssetManager() {
  const [files, setFiles] = useState<AssetFile[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const [uploading, setUploading] = useState<Record<string, boolean>>({});
  const [status, setStatus] = useState<Status>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const refresh = useCallback(async () => {
    try {
      setFiles(await listAssets());
      setLoadError(null);
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : 'Failed to load assets');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const handleUpload = async (filesIn: Iterable<File>) => {
    setStatus(null);
    for (const file of filesIn) {
      setUploading((prev) => ({ ...prev, [file.name]: true }));
      try {
        await uploadAsset(file);
        setStatus({ type: 'ok', text: `Uploaded ${file.name}` });
      } catch (e) {
        setStatus({
          type: 'error',
          text: `Failed to upload ${file.name}: ${e instanceof Error ? e.message : 'unknown error'}`,
        });
      } finally {
        setUploading((prev) => {
          const next = { ...prev };
          delete next[file.name];
          return next;
        });
      }
    }
    await refresh();
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(false);
    if (e.dataTransfer.files.length > 0) {
      void handleUpload(Array.from(e.dataTransfer.files));
    }
  };

  const handleInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files.length > 0) {
      void handleUpload(Array.from(e.target.files));
    }
    e.target.value = '';
  };

  const handleDelete = async (name: string) => {
    setStatus(null);
    try {
      await deleteAsset(name);
      await refresh();
      setStatus({ type: 'ok', text: `Deleted ${name}` });
    } catch (e) {
      setStatus({
        type: 'error',
        text: `Failed to delete ${name}: ${e instanceof Error ? e.message : 'unknown error'}`,
      });
    }
  };

  const uploadingCount = Object.keys(uploading).length;

  return (
    <div className="space-y-4">
      <input
        ref={inputRef}
        data-testid="asset-input"
        type="file"
        multiple
        hidden
        onChange={handleInputChange}
      />
      <button
        type="button"
        data-testid="asset-dropzone"
        aria-label="Drop OBS assets here to upload"
        onClick={() => inputRef.current?.click()}
        onDragOver={(e) => {
          e.preventDefault();
          setDragOver(true);
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={handleDrop}
        className={`flex w-full cursor-pointer flex-col items-center justify-center gap-2 rounded-card border border-dashed px-6 py-14 text-center transition-colors ${
          dragOver
            ? 'border-primary bg-primary-soft'
            : 'border-border hover:border-primary/50 hover:bg-bg-elevated'
        }`}
      >
        <svg
          aria-hidden="true"
          className={`h-8 w-8 ${dragOver ? 'text-primary' : 'text-text-faint'}`}
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
        >
          <path
            stroke-linecap="round"
            stroke-linejoin="round"
            stroke-width="1.5"
            d="M12 16.5V9.75m0 0l3 3m-3-3l-3 3M6.75 19.5a4.5 4.5 0 01-1.41-8.775 5.25 5.25 0 0110.233-2.33 3 3 0 013.758 3.848A3.752 3.752 0 0118 19.5H6.75z"
          />
        </svg>
        <div>
          <p className="text-sm font-medium text-text-primary">
            {dragOver ? 'Drop to upload' : 'Drag & drop OBS assets'}
          </p>
          <p className="mt-1 text-[13px] text-text-secondary">
            Uploaded assets land in the server's dependencies
            folder — or <span className="text-primary">click to browse</span>.
          </p>
        </div>
      </button>

      {uploadingCount > 0 && (
        <div
          className="flex items-center gap-2 px-1 text-sm text-text-secondary"
          role="status"
        >
          <svg
            aria-hidden="true"
            className="h-4 w-4 animate-spin text-primary"
            fill="none"
            viewBox="0 0 24 24"
          >
            <circle
              className="opacity-25"
              cx="12"
              cy="12"
              r="10"
              stroke="currentColor"
              strokeWidth="4"
            />
            <path
              className="opacity-75"
              fill="currentColor"
              d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z"
            />
          </svg>
          Uploading {uploadingCount} file{uploadingCount === 1 ? '' : 's'}
        </div>
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

      <div className="surface">
        <div className="flex items-center justify-between px-5 pt-5 pb-3">
          <div>
            <h3 className="text-sm font-semibold tracking-tight">
              Uploaded Assets
            </h3>
            <p className="mt-0.5 text-[13px] text-text-secondary">
              {loading
                ? 'Loading…'
                : loadError
                  ? 'Asset list unavailable'
                  : `${files.length} file${files.length === 1 ? '' : 's'} on this server`}
            </p>
          </div>
        </div>

        {loadError && !loading && (
          <p className="px-5 pb-5 text-sm text-danger" role="alert">
            Failed to load assets: {loadError}
          </p>
        )}

        {!loading && !loadError && files.length === 0 && (
          <p className="px-5 pb-8 text-sm text-text-faint">
            No assets yet — drag something into the box above.
          </p>
        )}

        {files.length > 0 && (
          <ul className="divide-y divide-border-subtle">
            {files.map((file) => {
              const isUploading = Boolean(uploading[file.name]);
              return (
                <li
                  key={file.name}
                  className="flex items-center gap-3 px-5 py-3"
                >
                  {isImage(file.name) ? (
                    <img
                      src={assetUrl(file.name)}
                      alt=""
                      loading="lazy"
                      data-testid="asset-thumb"
                      className="h-10 w-10 shrink-0 rounded-lg bg-bg-elevated object-cover ring-1 ring-inset ring-border-subtle"
                    />
                  ) : (
                    <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-bg-elevated text-text-faint">
                      <svg
                        aria-hidden="true"
                        className="h-4.5 w-4.5"
                        fill="none"
                        viewBox="0 0 24 24"
                        stroke="currentColor"
                      >
                        <path
                          stroke-linecap="round"
                          stroke-linejoin="round"
                          stroke-width="1.5"
                          d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"
                        />
                      </svg>
                    </div>
                  )}
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium text-text-primary tabular">
                      {file.name}
                    </p>
                    <p className="text-xs text-text-faint tabular">
                      {formatBytes(file.size)} · {formatDate(file.mtime)}
                    </p>
                  </div>
                  <div className="flex items-center gap-1.5">
                    {isUploading ? (
                      <span className="text-xs text-text-secondary">
                        Uploading…
                      </span>
                    ) : (
                      <>
                        <a
                          href={assetUrl(file.name)}
                          target="_blank"
                          rel="noopener"
                          aria-label={`Open ${file.name}`}
                          title={`Open ${file.name}`}
                          className="inline-flex h-8 w-8 items-center justify-center rounded-lg text-text-secondary transition-colors hover:bg-bg-elevated hover:text-text-primary"
                        >
                          <span className="sr-only">Open {file.name}</span>
                          <svg
                            aria-hidden="true"
                            className="h-4 w-4"
                            fill="none"
                            viewBox="0 0 24 24"
                            stroke="currentColor"
                          >
                            <path
                              stroke-linecap="round"
                              stroke-linejoin="round"
                              stroke-width="1.5"
                              d="M13.5 6H5.25A2.25 2.25 0 003 8.25v10.5A2.25 2.25 0 005.25 21h10.5A2.25 2.25 0 0018 18.75V10.5m-10.5 6L21 3m0 0h-5.25M21 3v5.25"
                            />
                          </svg>
                        </a>
                        <button
                          type="button"
                          aria-label={`Delete ${file.name}`}
                          title={`Delete ${file.name}`}
                          onClick={() => void handleDelete(file.name)}
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
                              stroke-linecap="round"
                              stroke-linejoin="round"
                              stroke-width="1.5"
                              d="M14.74 9l-.346 9m-4.788 0L9.26 9m9.968-3.21c.342.052.682.107 1.022.166m-1.022-.165L18.16 19.673a2.25 2.25 0 01-2.244 2.077H8.084a2.25 2.25 0 01-2.244-2.077L4.772 5.79m14.456 0a48.108 48.108 0 00-3.478-.397m-12 .562c.34-.059.68-.114 1.022-.165m0 0a48.11 48.11 0 013.478-.397m7.5 0v-.916c0-1.18-.91-2.164-2.09-2.201a51.964 51.964 0 00-3.32 0c-1.18.037-2.09 1.022-2.09 2.201v.916m7.5 0a48.667 48.667 0 00-7.5 0"
                            />
                          </svg>
                        </button>
                      </>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}
