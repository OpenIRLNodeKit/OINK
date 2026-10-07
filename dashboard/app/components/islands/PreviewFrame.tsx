"use client";
// SPDX-FileCopyrightText: 2026 OpenIRLNodeKit contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useEffect, useState } from 'react';

interface PreviewFrameProps {
  title: string;
  wrapperClass: string;
}

export default function PreviewFrame({ title, wrapperClass }: PreviewFrameProps) {
  const [error, setError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [visible, setVisible] = useState(true);

  // Don't decode (or encode server-side) a preview nobody is looking at: drop
  // the <img> src while the tab is hidden so the browser closes the MJPEG
  // stream, which stops the server's ffmpeg; reattach on return.
  useEffect(() => {
    const onVisibility = () => {
      const isVisible = document.visibilityState === 'visible';
      setVisible(isVisible);
      if (isVisible) {
        setLoaded(false);
        setError(null);
      }
    };
    onVisibility();
    document.addEventListener('visibilitychange', onVisibility);
    return () => document.removeEventListener('visibilitychange', onVisibility);
  }, []);

  // The feed is a same-origin MJPEG stream of OBS's virtual camera output
  // (nginx → log-server /api/preview/stream). An <img> renders it natively and
  // carries the session cookie, so no iframe or player dependency is needed.
  useEffect(() => {
    const timer = setTimeout(() => {
      if (!loaded) setError('Preview feed unavailable');
    }, 10000);
    return () => clearTimeout(timer);
  }, [loaded]);

  return (
    <div className={wrapperClass}>
      <img
        src={visible ? '/api/preview/stream' : undefined}
        alt={title}
        className="absolute inset-0 h-full w-full object-contain"
        onLoad={() => setLoaded(true)}
        onError={() => setError('Failed to load preview')}
      />

      {!loaded && !error && (
        <div className="absolute inset-0 flex flex-col items-center justify-center pointer-events-none">
          <div className="w-12 h-12 mb-3 border-2 border-primary border-t-transparent rounded-full animate-spin"></div>
          <p className="text-text-secondary text-sm">Connecting to preview feed…</p>
        </div>
      )}

      {error && (
        <div className="absolute inset-0 flex items-center justify-center">
          <div className="text-center px-6">
            <div className="w-10 h-10 mx-auto mb-3 rounded-full bg-danger/20 flex items-center justify-center">
              <svg className="w-5 h-5 text-danger" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
              </svg>
            </div>
            <p className="text-text-secondary text-sm">Preview feed unavailable</p>
            <p className="text-xs text-text-secondary/60 mt-1 break-all">{error}</p>
          </div>
        </div>
      )}

    </div>
  );
}
