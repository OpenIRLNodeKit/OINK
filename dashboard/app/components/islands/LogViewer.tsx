"use client";
// SPDX-FileCopyrightText: 2026 OpenIRLNodeKit contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useState, useEffect, useRef, type ReactNode } from 'react';

interface LogViewerProps {
  service: string;
  label?: string;
}

// ANSI escape code parser — converts to colored spans
const ANSI_REGEX = /\x1b\[([0-9;]*)m/g;

const ANSI_STYLES: Record<string, string> = {
  '0': '',
  '1': 'font-bold',
  '2': 'opacity-60',
  '3': 'italic',
  '4': 'underline',
  '30': 'text-gray-500',
  '31': 'text-red-400',
  '32': 'text-green-400',
  '33': 'text-yellow-400',
  '34': 'text-blue-400',
  '35': 'text-purple-400',
  '36': 'text-cyan-400',
  '37': 'text-gray-300',
  '90': 'text-gray-600',
  '91': 'text-red-500',
  '92': 'text-green-500',
  '93': 'text-yellow-500',
  '94': 'text-blue-500',
  '95': 'text-purple-500',
  '96': 'text-cyan-500',
  '97': 'text-white',
};

function parseAnsi(line: string): ReactNode[] {
  const parts: ReactNode[] = [];
  let current = '';
  let activeClasses = '';
  let key = 0;

  const reset = () => {
    if (current) {
      parts.push(
        <span key={key++} className={activeClasses || undefined}>
          {current}
        </span>
      );
      current = '';
    }
  };

  let lastIndex = 0;
  let match: RegExpExecArray | null;

  ANSI_REGEX.lastIndex = 0;
  while ((match = ANSI_REGEX.exec(line)) !== null) {
    // Add text before this escape
    current += line.slice(lastIndex, match.index);
    lastIndex = match.index + match[0].length;

    // Parse the codes
    const codes = match[1].split(';');
    let newClasses = '';
    for (const code of codes) {
      const style = ANSI_STYLES[code];
      if (style === undefined) continue;
      if (code === '0') {
        newClasses = '';
      } else {
        newClasses += ' ' + style;
      }
    }
    if (newClasses) {
      reset();
      activeClasses = newClasses.trim();
    } else {
      reset();
      activeClasses = '';
    }
  }

  // Remaining text
  current += line.slice(lastIndex);
  reset();

  return parts.length > 0 ? parts : [<span key={0}>{line}</span>];
}

function stripAnsi(line: string): string {
  return line.replace(ANSI_REGEX, '');
}

export default function LogViewer({ service, label }: LogViewerProps) {
  const [logs, setLogs] = useState<string[]>([]);
  const [connected, setConnected] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const logEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let cancelled = false;
    let ws: WebSocket | null = null;
    let reconnectTimeout: ReturnType<typeof setTimeout>;
    let retryDelay = 1000;

    setLogs([]);
    setConnected(false);
    setError(null);

    function connect() {
      if (cancelled) return;
      try {
        const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
        const host = window.location.host;
        ws = new WebSocket(`${protocol}//${host}/api/logs/${service}`);

        ws.onopen = () => {
          if (cancelled) return;
          setConnected(true);
          setError(null);
          retryDelay = 1000;
        };

        ws.onmessage = (event) => {
          if (cancelled) return;
          const data = event.data;
          if (data === '[DONE]') return;
          setLogs((prev) => {
            const next = [...prev, data];
            return next.length > 500 ? next.slice(-500) : next;
          });
        };

        ws.onerror = () => {
          if (cancelled) return;
          setConnected(false);
          setError('WebSocket error — API not connected');
        };

        ws.onclose = () => {
          setConnected(false);
          if (cancelled) return;
          reconnectTimeout = setTimeout(connect, retryDelay);
          retryDelay = Math.min(retryDelay * 1.5, 30000);
        };
      } catch {
        setError('Failed to connect');
      }
    }

    connect();

    return () => {
      cancelled = true;
      clearTimeout(reconnectTimeout);
      ws?.close();
    };
  }, [service]);

  useEffect(() => {
    logEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [logs]);

  function downloadLogs() {
    const filename = `${(label || service).toLowerCase().replace(/\s+/g, '-')}-logs-${new Date().toISOString().slice(0, 19).replace(/[T:]/g, '-')}.txt`;
    const clean = logs.map(stripAnsi).join('\n');
    const blob = new Blob([clean], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <div className="bg-black rounded-b-xl overflow-hidden">
      {/* Status bar */}
      <div className="flex items-center gap-2 px-4 py-1.5 bg-black/50 border-b border-border text-xs">
        <div className={`w-1.5 h-1.5 rounded-full ${connected ? 'bg-success' : 'bg-danger'}`} />
        <span className="text-text-secondary font-mono">
          {connected ? 'connected' : error || 'connecting...'}
        </span>
        <span className="text-text-secondary/40 font-mono">
          {logs.length} lines
        </span>
        <button
          onClick={downloadLogs}
          disabled={logs.length === 0}
          className="ml-auto px-2 py-0.5 rounded bg-bg-card border border-border text-text-secondary hover:text-text-primary hover:bg-primary/20 disabled:opacity-30 disabled:cursor-not-allowed transition-colors font-mono"
        >
          Download
        </button>
      </div>

      {/* Log output */}
      <div className="h-80 overflow-y-auto p-4 font-mono text-xs leading-relaxed">
        {logs.length === 0 && (
          <div className="text-text-secondary/40">
            {connected ? 'Waiting for logs...' : 'Connecting to service...'}
          </div>
        )}
        {logs.map((line, i) => (
          <div key={i} className="whitespace-pre-wrap break-all">
            {parseAnsi(line)}
          </div>
        ))}
        <div ref={logEndRef} />
      </div>
    </div>
  );
}
