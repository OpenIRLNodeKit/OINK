"use client";
// SPDX-FileCopyrightText: 2026 OpenIRLNodeKit contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useEffect, useRef, useState } from 'react';
import { removeAvatar, uploadAvatar } from '../../lib/auth';
import { useAuth } from '../../lib/auth-context';
import { Button, Card } from '../ui';

const ACCEPTED = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'];
const MAX_BYTES = 1024 * 1024;

function initialsFor(name: string): string {
  return name
    .split(/[^a-z0-9]+/i)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0].toUpperCase())
    .join('')
    .padEnd(2, '?')
    .slice(0, 2);
}

export default function AccountProfileCard() {
  const { user, enabled, refresh } = useAuth();
  const [file, setFile] = useState<File | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const objectUrlRef = useRef<string | null>(null);

  const username = enabled && user ? user.username : '';
  const hasAvatar = (enabled && user?.avatarUrl) || previewUrl !== null;

  useEffect(() => {
    return () => {
      if (objectUrlRef.current) URL.revokeObjectURL(objectUrlRef.current);
    };
  }, []);

  function onPick(next: File | null) {
    setMessage(null);
    if (!next) {
      setFile(null);
      if (objectUrlRef.current) URL.revokeObjectURL(objectUrlRef.current);
      objectUrlRef.current = null;
      setPreviewUrl(null);
      return;
    }
    if (!ACCEPTED.includes(next.type)) {
      setMessage({ ok: false, text: 'Picture must be a PNG, JPEG, WebP, or GIF image' });
      return;
    }
    if (next.size > MAX_BYTES) {
      setMessage({ ok: false, text: 'Picture must be 1 MB or smaller' });
      return;
    }
    if (objectUrlRef.current) URL.revokeObjectURL(objectUrlRef.current);
    objectUrlRef.current = URL.createObjectURL(next);
    setFile(next);
    setPreviewUrl(objectUrlRef.current);
  }

  async function handleUpload() {
    if (!file) return;
    setBusy(true);
    setMessage(null);
    const result = await uploadAvatar(file);
    setBusy(false);
    if (result.ok) {
      setFile(null);
      if (objectUrlRef.current) URL.revokeObjectURL(objectUrlRef.current);
      objectUrlRef.current = null;
      setPreviewUrl(null);
      await refresh();
      setMessage({ ok: true, text: 'Profile picture updated.' });
    } else {
      setMessage({ ok: false, text: result.error ?? 'Upload failed' });
    }
  }

  async function handleRemove() {
    setBusy(true);
    setMessage(null);
    const result = await removeAvatar();
    setBusy(false);
    if (result.ok) {
      setFile(null);
      setPreviewUrl(null);
      await refresh();
      setMessage({ ok: true, text: 'Profile picture removed.' });
    } else {
      setMessage({ ok: false, text: result.error ?? 'Remove failed' });
    }
  }

  const src = previewUrl ?? (user?.avatarUrl || null);

  return (
    <Card
      title="Profile Picture"
      description="Set a picture for your account. It is stored on the box and shown in the header."
    >
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-center gap-4">
          <div className="flex h-16 w-16 items-center justify-center overflow-hidden rounded-full bg-primary text-lg font-semibold text-bg-dark">
            {src ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={src}
                alt="Profile"
                className="h-full w-full object-cover"
              />
            ) : (
              initialsFor(username || 'Local')
            )}
          </div>
          <input
            id="avatar-upload"
            type="file"
            aria-label="Choose profile picture"
            accept={ACCEPTED.join(',')}
            className="block text-sm text-text-secondary file:mr-3 file:rounded-control file:border-0 file:bg-bg-elevated file:px-3 file:py-1.5 file:text-xs file:font-medium file:text-text-primary file:transition-colors hover:file:bg-border-subtle"
            onChange={(e) => onPick(e.target.files?.[0] ?? null)}
          />
        </div>
        <div className="flex items-center gap-2">
          <Button type="button" onClick={handleUpload} disabled={busy || !file}>
            {busy ? 'Uploading…' : 'Upload picture'}
          </Button>
          {hasAvatar && (
            <Button type="button" onClick={handleRemove} disabled={busy} variant="ghost">
              Remove
            </Button>
          )}
        </div>
      </div>
      {message && (
        <p
          className={`mt-3 text-sm ${message.ok ? 'text-success' : 'text-danger'}`}
          role="status"
        >
          {message.text}
        </p>
      )}
    </Card>
  );
}
