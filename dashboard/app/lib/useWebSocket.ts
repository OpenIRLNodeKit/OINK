// SPDX-FileCopyrightText: 2026 OpenIRLNodeKit contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
import { useCallback, useEffect, useRef, useState } from 'react';

type ConnectionState =
  | 'connecting'
  | 'connected'
  | 'reconnecting'
  | 'disconnected';

const MAX_RETRIES = 5;
const BASE_DELAY = 1000;
const MAX_DELAY = 15000;

export function resolveWebSocketUrl(path: string): string {
  if (typeof window === 'undefined') return path;
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${protocol}//${window.location.host}${path}`;
}

export function backoffDelay(attempt: number): number {
  return Math.min(BASE_DELAY * 2 ** attempt, MAX_DELAY);
}

interface UseWebSocketOptions<T> {
  onMessage?: (data: T) => void;
  enabled?: boolean;
}

export function useWebSocket<T = unknown>(
  path: string,
  options: UseWebSocketOptions<T> = {},
) {
  const { onMessage, enabled = true } = options;
  const onMessageRef = useRef(onMessage);
  const [status, setStatus] = useState<ConnectionState>('connecting');
  const retriesRef = useRef(0);
  const wsRef = useRef<WebSocket | null>(null);

  useEffect(() => {
    onMessageRef.current = onMessage;
  }, [onMessage]);

  useEffect(() => {
    if (!enabled) {
      setStatus('disconnected');
      return;
    }

    let cancelled = false;
    let reconnectTimer: ReturnType<typeof setTimeout>;

    function connect() {
      if (cancelled) return;
      setStatus(retriesRef.current > 0 ? 'reconnecting' : 'connecting');

      let ws: WebSocket;
      try {
        ws = new WebSocket(resolveWebSocketUrl(path));
      } catch {
        scheduleReconnect();
        return;
      }
      wsRef.current = ws;

      ws.onopen = () => {
        retriesRef.current = 0;
        setStatus('connected');
      };

      ws.onmessage = (event) => {
        try {
          const data = JSON.parse(String(event.data)) as T;
          onMessageRef.current?.(data);
        } catch {
          onMessageRef.current?.(event.data as T);
        }
      };

      ws.onclose = () => {
        if (cancelled) return;
        setStatus(
          retriesRef.current >= MAX_RETRIES ? 'disconnected' : 'reconnecting',
        );
        scheduleReconnect();
      };

      ws.onerror = () => {
        ws.close();
      };
    }

    function scheduleReconnect() {
      if (cancelled || retriesRef.current >= MAX_RETRIES) return;
      const delay = backoffDelay(retriesRef.current);
      retriesRef.current += 1;
      reconnectTimer = setTimeout(connect, delay);
    }

    connect();

    return () => {
      cancelled = true;
      clearTimeout(reconnectTimer);
      wsRef.current?.close();
    };
  }, [path, enabled]);

  const reconnect = useCallback(() => {
    retriesRef.current = 0;
    wsRef.current?.close();
  }, []);

  return { status, reconnect };
}
