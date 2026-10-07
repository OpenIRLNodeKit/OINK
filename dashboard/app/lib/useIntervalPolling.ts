// SPDX-FileCopyrightText: 2026 OpenIRLNodeKit contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
import { useEffect, useRef } from 'react';

export function useIntervalPolling(
  fn: () => void | Promise<void>,
  intervalMs: number,
): void {
  const ref = useRef(fn);
  useEffect(() => {
    ref.current = fn;
  }, [fn]);

  useEffect(() => {
    void ref.current();
    const id = window.setInterval(() => void ref.current(), intervalMs);
    return () => window.clearInterval(id);
  }, [intervalMs]);
}
