'use client';
// SPDX-FileCopyrightText: 2026 OpenIRLNodeKit contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useEffect, useRef, useState } from 'react';

interface PreviewFrameProps {
  title: string;
  wrapperClass: string;
  /** Show a fullscreen toggle. Gated on browser support (off on iPhone Safari). */
  fullscreen?: boolean;
}

function ExpandIcon() {
  return (
    <svg
      className="h-5 w-5"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M8 3H5a2 2 0 0 0-2 2v3m18 0V5a2 2 0 0 0-2-2h-3m0 18h3a2 2 0 0 0 2-2v-3M3 16v3a2 2 0 0 0 2 2h3" />
    </svg>
  );
}

function CompressIcon() {
  return (
    <svg
      className="h-5 w-5"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M8 3v3a2 2 0 0 1-2 2H3m18 0h-3a2 2 0 0 1-2-2V3m0 18v-3a2 2 0 0 1 2-2h3M3 16h3a2 2 0 0 1 2 2v3" />
    </svg>
  );
}

export default function PreviewFrame({
  title,
  wrapperClass,
  fullscreen = false,
}: PreviewFrameProps) {
  const [error, setError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [visible, setVisible] = useState(true);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [canFullscreen, setCanFullscreen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

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

  useEffect(() => {
    if (!fullscreen) return;
    setCanFullscreen(Boolean(document.fullscreenEnabled));
    const onChange = () =>
      setIsFullscreen(document.fullscreenElement === containerRef.current);
    document.addEventListener('fullscreenchange', onChange);
    return () => document.removeEventListener('fullscreenchange', onChange);
  }, [fullscreen]);

  // The feed is a same-origin MJPEG stream of OBS's virtual camera output
  // (nginx → log-server /api/preview/stream). An <img> renders it natively and
  // carries the session cookie, so no iframe or player dependency is needed.
  useEffect(() => {
    const timer = setTimeout(() => {
      if (!loaded) setError('Preview feed unavailable');
    }, 10000);
    return () => clearTimeout(timer);
  }, [loaded]);

  const toggleFullscreen = async () => {
    const el = containerRef.current;
    if (!el) return;
    try {
      if (document.fullscreenElement) await document.exitFullscreen();
      else await el.requestFullscreen();
    } catch {
      // Unsupported or blocked (e.g. non-video fullscreen on iPhone Safari).
    }
  };

  return (
    <div ref={containerRef} className={wrapperClass}>
      <img
        src={visible ? '/api/preview/stream' : undefined}
        alt={title}
        className="absolute inset-0 h-full w-full object-contain"
        onLoad={() => setLoaded(true)}
        onError={() => setError('Failed to load preview')}
      />

      {fullscreen && canFullscreen && (
        <button
          type="button"
          onClick={() => void toggleFullscreen()}
          aria-pressed={isFullscreen}
          aria-label={isFullscreen ? 'Exit fullscreen' : 'Enter fullscreen'}
          title={isFullscreen ? 'Exit fullscreen' : 'Enter fullscreen'}
          className="absolute right-3 top-3 z-10 inline-flex h-9 w-9 items-center justify-center rounded-control bg-black/60 text-white ring-1 ring-inset ring-white/20 transition-colors hover:bg-black/80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/70"
        >
          {isFullscreen ? <CompressIcon /> : <ExpandIcon />}
        </button>
      )}

      {!loaded && !error && (
        <div className="absolute inset-0 flex flex-col items-center justify-center pointer-events-none">
          <div className="w-12 h-12 mb-3 border-2 border-primary border-t-transparent rounded-full animate-spin"></div>
          <p className="text-text-secondary text-sm">
            Connecting to preview feed…
          </p>
        </div>
      )}

      {error && (
        <div className="absolute inset-0 flex items-center justify-center">
          <div className="text-center px-6">
            <div className="w-10 h-10 mx-auto mb-3 rounded-full bg-danger/20 flex items-center justify-center">
              <svg
                className="w-5 h-5 text-danger"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
                aria-hidden="true"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"
                />
              </svg>
            </div>
            <p className="text-text-secondary text-sm">
              Preview feed unavailable
            </p>
            <p className="text-xs text-text-secondary/60 mt-1 break-all">
              {error}
            </p>
          </div>
        </div>
      )}
    </div>
  );
}
