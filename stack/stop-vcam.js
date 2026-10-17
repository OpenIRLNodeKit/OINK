#!/usr/bin/env node
// SPDX-FileCopyrightText: 2026 OpenIRLNodeKit contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
// Stop OBS's virtual camera gracefully before the oink-obs unit tears OBS down.
// Runs as the unit's ExecStop so OBS is still alive to answer the websocket
// call; a dead/unreachable OBS just skips (systemctl must never be blocked).
const timer = setTimeout(() => process.exit(0), 5000);
timer.unref();
require('./obs-bridge').stopVirtualCam().catch(() => {}).then(() => process.exit(0));
