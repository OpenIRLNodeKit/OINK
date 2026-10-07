#!/usr/bin/env python3
# SPDX-FileCopyrightText: 2026 OpenIRLNodeKit contributors
# SPDX-License-Identifier: AGPL-3.0-or-later
"""cleanup.py — `oink cleanup`: fully uninstall OpenIRLNodeKit.

Removes everything `oink setup` put on a host (host phase and native stack),
returning it close to the state before the project was installed:

  * stops, disables, and removes the `oink-*` systemd units, the `oink` CLI
    symlink, and the `/usr/local/libexec/oink/` helper scripts
  * removes the polkit rule that lets the runtime user control the dashboard
    services (and the systemd-journal group grant)
  * removes the X11 dummy-display config
  * removes the native OBS Studio config (`~/.config/obs-studio` + golden)
  * removes the runtime user's `~/oink`, `~/guac-spike`, `~/dependencies`,
    `~/recordings`
  * removes the host-setup state file (scripts/state/host_state.json) so
    a subsequent `oink setup` starts from a clean slate
  * removes the dedicated runtime user + shared group (obsuser/oink)

LEFT INSTALLED — `oink setup` may not have been the only installer, so these
are NOT touched and are listed in the summary for you to remove manually:

  * the apt packages the host phase installed (obs-studio, guacd, nodejs,
    x11vnc, xserver-xorg-*, ffmpeg, xdotool, python3-websocket, ...)
  * the OBS PPA repo (/etc/apt/sources.list.d/obsproject-ubuntu-obs-studio-*.list)
  * the NodeSource apt repository (/etc/apt/sources.list.d/nodesource.list)

Wired into the single CLI as `oink cleanup` (see oink.py). Targets a host that
has run `oink setup`; a developer checkout's own build artifacts are untouched.

Usage:
    sudo python3 oink.py cleanup [-y] [--dry-run]
"""

from __future__ import annotations

import os
import pathlib
import shutil

from constants import (
    BASE_PKGS,
    COMMON_PKGS,
    GUAC_PKGS,
    OBS_PKGS,
    OINK_GROUP,
    OINK_LIBEXEC,
    SECURITY_PKGS,
    STATE_FILE,
    X11_PKGS,
)
from logui import bail, confirm, info, warn
from models import SetupConfig
from process import run

# Units registered by `oink setup` (distro `guacd.service` is apt-managed and
# deliberately left installed, like the other apt packages; the apt `nginx`
# binary is used by `oink-nginx` but its distro unit is stopped/disabled, not
# part of this list)
SYSTEMD_UNITS = [
    "oink-display", "oink-obs", "oink-firewall", "oink-vnc", "oink-guac",
    "oink-nginx", "oink-mediamtx", "oink-noalbs", "oink-api",
]
BIN_SCRIPTS = [
    "/usr/local/bin/oink",
]
DUMMY_CONF = pathlib.Path("/etc/X11/xorg.conf.d/10-oink-dummy.conf")
POLKIT_RULE = pathlib.Path("/etc/polkit-1/rules.d/10-oink-service-control.rules")
FAIL2BAN_FILTER = pathlib.Path("/etc/fail2ban/filter.d/oink-auth.conf")
FAIL2BAN_JAIL = pathlib.Path("/etc/fail2ban/jail.d/oink-auth.local")
LOGROTATE_CONF = pathlib.Path("/etc/logrotate.d/oink-nginx")


def _rm_path(cfg: SetupConfig, path: pathlib.Path, desc: str) -> None:
    if cfg.dry_run:
        info(cfg, f"  → Would remove {desc}: {path}")
        return
    if not path.exists():
        info(cfg, f"  ⊘ {desc} (not found): {path}")
        return
    if path.is_dir():
        shutil.rmtree(path)
    else:
        path.unlink()
    info(cfg, f"  → Removed {desc}: {path}")


def cleanup_main(cfg: SetupConfig) -> int:
    if os.geteuid() != 0:
        bail(cfg, "Run as root (sudo).")

    info(cfg, "════════════════════════════════════════════════════════════")
    info(cfg, "  OpenIRLNodeKit — Host Uninstall")
    info(cfg, "════════════════════════════════════════════════════════════")
    info(cfg, f"  Target user: {cfg.user} ({cfg.home})")

    if not confirm(cfg, "Uninstall OpenIRLNodeKit from this host "
                        "(services, OBS, native stack)?"):
        bail(cfg, "Uninstall cancelled by user.")

    # ── Systemd units ─────────────────────────────────────────────────────────
    info(cfg, "Removing OINK systemd services…")
    for unit in SYSTEMD_UNITS:
        unit_file = pathlib.Path(f"/etc/systemd/system/{unit}.service")
        if not (cfg.dry_run or unit_file.exists()):
            info(cfg, f"  ⊘ {unit}.service (not found)")
            continue
        run(cfg, "systemctl", "stop", unit, check=False)
        run(cfg, "systemctl", "disable", unit, check=False)
        _rm_path(cfg, unit_file, f"{unit}.service")
    run(cfg, "systemctl", "daemon-reload")
    run(cfg, "systemctl", "reset-failed", check=False)
    # nftables table the port guard creates (ExecStop removes it on stop; this
    # covers a table left behind if the unit was already gone).
    run(cfg, "nft", "delete", "table", "inet", "oink", check=False)

    # ── Helper scripts + X11 config + polkit ──────────────────────────────────
    info(cfg, "Removing helper scripts, X11 config, and polkit rule…")
    for script in BIN_SCRIPTS:
        _rm_path(cfg, pathlib.Path(script), pathlib.Path(script).name)
    _rm_path(cfg, OINK_LIBEXEC, "oink helper scripts (/usr/local/libexec/oink)")
    _rm_path(cfg, DUMMY_CONF, "X11 dummy-display config")
    _rm_path(cfg, POLKIT_RULE, "polkit service-control rule")
    run(cfg, "gpasswd", "-d", cfg.obs_user, "systemd-journal", check=False)

    # ── fail2ban drop-ins (the apt package is left to the summary) ────────────
    info(cfg, "Removing fail2ban jail and logrotate drop-in…")
    _rm_path(cfg, FAIL2BAN_FILTER, "fail2ban filter (oink-auth)")
    _rm_path(cfg, FAIL2BAN_JAIL, "fail2ban jail (oink-auth)")
    _rm_path(cfg, LOGROTATE_CONF, "nginx access-log logrotate config")
    run(cfg, "systemctl", "disable", "--now", "fail2ban", check=False)

    # ── OBS Studio config (native; the apt package is left to the summary) ────
    info(cfg, "Removing OBS Studio config…")
    _rm_path(cfg, cfg.obs_cfg, "OBS config (~/.config/obs-studio)")
    _rm_path(cfg, cfg.obs_home / "user.ini.golden", "golden user.ini")

    # ── Home artifacts ────────────────────────────────────────────────────────
    info(cfg, "Removing installed stack and tunnel…")
    _rm_path(cfg, cfg.obs_home / "oink", "installed stack (~/oink)")
    _rm_path(cfg, cfg.guac_dir, "Guacamole tunnel (~/guac-spike)")
    _rm_path(cfg, cfg.dep_dir, "dependencies dir (~/dependencies)")
    _rm_path(cfg, cfg.recording_dir, "recordings dir (~/recordings)")

    # ── Host-setup state ───────────────────────────────────────────────────────
    info(cfg, "Removing host-setup state…")
    _rm_path(cfg, STATE_FILE, "host-setup state file")

    # ── Runtime user + group ──────────────────────────────────────────────────
    info(cfg, "Removing runtime user and group…")
    run(cfg, "gpasswd", "-d", cfg.user, OINK_GROUP, check=False)
    # userdel -r removes the account's home (incl. ~/.cache and ~/.config);
    # groupdel clears the private primary group useradd --system created.
    run(cfg, "userdel", "-r", cfg.obs_user, check=False)
    run(cfg, "groupdel", cfg.obs_user, check=False)
    run(cfg, "groupdel", OINK_GROUP, check=False)

    # ── Summary: left behind ──────────────────────────────────────────────────
    warn(cfg, "──────────────────────────────────────────────────────────────")
    warn(cfg, "  Left installed (`oink setup` installed these — remove if you want)")
    warn(cfg, "──────────────────────────────────────────────────────────────")
    pkgs = sorted(
        set(X11_PKGS) | set(COMMON_PKGS) | set(BASE_PKGS) | set(GUAC_PKGS)
        | set(OBS_PKGS) | set(SECURITY_PKGS)
    )
    warn(cfg, f"  apt packages: {' '.join(pkgs)}")
    warn(cfg, "  → purge them:  sudo apt-get purge -y " + " ".join(pkgs))
    warn(cfg, "  → nginx (apt, reverse proxy used by the stack):  sudo apt-get purge -y nginx")
    warn(cfg, "    (its distro nginx.service was disabled by setup; re-enable with sudo systemctl enable --now nginx)")
    warn(cfg, "  → drop orphaned deps:  sudo apt-get autoremove --purge -y")
    warn(cfg, "  → OBS PPA repo:  sudo add-apt-repository --remove ppa:obsproject/obs-studio")
    warn(cfg, "  → NodeSource repo: /etc/apt/sources.list.d/nodesource.list")
    warn(cfg, "  → purge Node.js:  sudo apt-get purge -y nodejs")
    warn(cfg, "──────────────────────────────────────────────────────────────")

    return 0
