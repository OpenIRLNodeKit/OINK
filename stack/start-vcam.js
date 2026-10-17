#!/usr/bin/env node
// SPDX-FileCopyrightText: 2026 OpenIRLNodeKit contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
// ExecStartPost shim: restore the OBS virtual camera after oink-obs (re)starts,
// but only when it was on before the teardown (see vcam-state.js). obs-websocket
// isn't listening the instant OBS execs, so retry until it answers or the
// deadline passes. Started backgrounded by the unit so it never blocks the
// systemd start job; a dead OBS / missing flag just exits.
const DEADLINE_MS = 60000;
const RETRY_MS = 1000;

const { isWanted } = require('./vcam-state');
const { startVirtualCam } = require('./obs-bridge');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  if (!isWanted(__dirname)) return;
  const deadline = Date.now() + DEADLINE_MS;
  while (Date.now() < deadline) {
    try {
      await startVirtualCam();
      return;
    } catch {
      await sleep(RETRY_MS);
    }
  }
})().finally(() => process.exit(0));
