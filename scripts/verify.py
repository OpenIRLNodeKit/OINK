# SPDX-FileCopyrightText: 2026 OpenIRLNodeKit contributors
# SPDX-License-Identifier: AGPL-3.0-or-later
"""Post-install health checks."""

from __future__ import annotations

import os
import subprocess
import time

from constants import (
    CLIENT_PORT,
    OBS_HOME,
    OBS_WS_PORT,
    TUNNEL_PORT,
    VERIFY_TIMEOUT,
    VNC_PORT,
)
from logui import info, warn
from models import HostState, Result, SetupConfig
from process import wait_check

STRAY_TITLES = ["WebSocket Server Settings", "Output Timer", "Stats", "Missing Files"]

def _sweep_stray_windows(cfg: SetupConfig) -> None:
    """Close stray OBS dialog windows that pop up after ws comes up."""
    left = 0
    for _round in range(6):
        for title in STRAY_TITLES:
            subprocess.run(
                ["xdotool", "search", "--name", title, "windowclose"],
                capture_output=True, check=False,
            )
        time.sleep(3)
        left = 0
        for title in STRAY_TITLES:
            r = subprocess.run(
                ["xdotool", "search", "--name", title],
                capture_output=True, text=True, check=False,
            )
            left += len(r.stdout.strip().splitlines()) if r.stdout.strip() else 0
        if left == 0:
            return
    warn(cfg, f"  Stray windows persist ({left})")


def verify(cfg: SetupConfig, state: HostState) -> Result:
    """Run post-install health checks with shared retry deadline."""
    print()
    info(cfg, "════════════════════════════════════════════════════════════")
    info(cfg, "  Verification")
    info(cfg, "════════════════════════════════════════════════════════════")

    deadline = time.time() + VERIFY_TIMEOUT
    results: list[tuple[str, bool]] = []

    def check(desc: str, cmd: str) -> None:
        results.append((desc, wait_check(cfg, desc, cmd, deadline)))

    check("oink-display active", "systemctl is-active oink-display")
    check("oink-vnc active", "systemctl is-active oink-vnc")
    check("oink-obs active", "systemctl is-active oink-obs")
    check("Display :99 responding", "DISPLAY=:99 xdpyinfo >/dev/null 2>&1")
    check(f"OBS websocket on :{OBS_WS_PORT}", f"ss -ltn | grep -q ':{OBS_WS_PORT}'")
    check(f"x11vnc on :{VNC_PORT}", f"ss -ltn | grep -q ':{VNC_PORT} '")

    if os.path.exists("/dev/nvidia0"):
        check("NVIDIA driver loaded", "nvidia-smi -L")
        check("OBS rendering on NVIDIA",
              f'grep -q "Loading up OpenGL on adapter NVIDIA" '
              f'"$(ls -t {OBS_HOME}/.config/obs-studio/logs/*.txt | head -1)"')

    check("guacd active", "systemctl is-active guacd")
    check("oink-guac active", "systemctl is-active oink-guac")
    check("guacd on :4822", "ss -ltn | grep -q ':4822'")
    check(f"Tunnel on :{TUNNEL_PORT}", f"ss -ltn | grep -q ':{TUNNEL_PORT}'")
    check(f"Client page on :{CLIENT_PORT}", f"ss -ltn | grep -q ':{CLIENT_PORT}'")

    # Sweep stray OBS dialog windows (WebSocket Server Settings, Output Timer, etc.)
    if all(ok for _, ok in results):
        _sweep_stray_windows(cfg)

    passed = all(ok for _, ok in results)
    runtime = int(time.time() - cfg.started_at)

    print()
    if passed:
        # Get first non-loopback IP
        try:
            ip = subprocess.check_output(
                ["hostname", "-I"], text=True
            ).strip().split()[0]
        except Exception:
            ip = "???"
        info(cfg, "════════════════════════════════════════════════════════════")
        info(cfg, "  All checks passed \u2713")
        info(cfg, f"  Remote OBS: http://{ip}:{os.environ.get('OINK_WEB_PORT', '8305')}/remote/")
        info(cfg, f"  Total runtime: {runtime // 60}m{runtime % 60}s")
        info(cfg, "════════════════════════════════════════════════════════════")
        return Result(True)
    warn(cfg, "════════════════════════════════════════════════════════════")
    warn(cfg, "  Some checks failed \u2014 review output above")
    warn(cfg, "  Logs: journalctl -u oink-obs -n 30")
    warn(cfg, f"  Total runtime: {runtime // 60}m{runtime % 60}s")
    warn(cfg, "════════════════════════════════════════════════════════════")
    return Result(False, "verification failed")
