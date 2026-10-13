#!/usr/bin/env python3
# SPDX-FileCopyrightText: 2026 OpenIRLNodeKit contributors
# SPDX-License-Identifier: AGPL-3.0-or-later
"""oink.py — OpenIRLNodeKit CLI.

Single entry point with three subcommands (`oink` is installed as a symlink to
this file, so the short form works from any directory once setup has run):

    sudo oink setup    [-y] [--dry-run]
    sudo oink upgrade  [--check] [-y]
    sudo oink cleanup  [-y] [--dry-run]
    oink status        [--json]
    sudo oink users    list | reset <user>
    sudo oink backup   [-o FILE] [--encrypt]
    sudo oink restore  FILE [-y] [--dry-run] [--force]

* setup — turns a fresh Ubuntu 24.04 system into a running OpenIRLNodeKit node
  in one command. It runs the host phase first (virtual display, headless OBS
  (native, from the OBS PPA) with obs-websocket, x11vnc loopback, and the
  Guacamole browser tunnel; phases pulled from the sibling modules in scripts/
  — models.py, sections.py, verify.py, ...), then the native-stack phase
  (builds the React Router dashboard and installs/runs Nginx, MediaMTX ingest,
  NOALBS, log-server as systemd units from a repo checkout). Needs the full repo
  checkout (dashboard, stack/) and Node >= 22.12.0, else it fails at the stack
  phase §1 gate. Idempotent: safe to re-run; each phase skips steps that are
  already done, so re-running converges either part.
* cleanup — fully uninstalls from a host: stops/removes the oink-* services,
  the `oink` CLI symlink + libexec helpers, X11 dummy config, the native OBS
  install/config dirs, the installed stack/key dirs, and reverts setup's system
  tweaks. Apt packages (incl. OBS + the OBS PPA repo) / NodeSource repo are
  listed in a summary but left installed.
* status — read-only health report of the host units and the native stack.
"""

from __future__ import annotations

import pathlib
import sys

# The shared modules live in scripts/, so make them importable.
sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent / "scripts"))

import argparse
import hashlib
import json
import os
import re
import shutil
import subprocess
import time
from argparse import Namespace
from collections.abc import Callable

import backup
import cleanup
import stack
import status
import upgrade
from constants import (
    AITUM_PLUGINS,
    BACKUP_PKGS,
    IRL_SOURCE,
    MIN_VERSIONS,
    OINK_LIBEXEC,
    TAR_PKGS,
    VERTICAL_SCENE_COLLECTION,
)
from logui import bail, info
from models import HostState, Phase, Result, SetupConfig
from obs_profile import plugin_matches, section_obs_vertical
from process import run_ok
from sections import (
    section_aitum_plugins,
    section_base_packages,
    section_dummy_display,
    section_guacamole,
    section_obs_golden,
    section_obs_install,
    section_obs_irl_source,
    section_obs_scenes,
    section_obs_user,
    section_obs_websocket,
    section_oink_display,
    section_oink_obs,
    section_oink_vnc,
)
from verify import verify

PHASE_SECTIONS: list[tuple[Phase, Callable[[SetupConfig, HostState], Result]]] = [
    (Phase.BASE_PACKAGES, section_base_packages),
    (Phase.OBS_USER, section_obs_user),
    (Phase.DUMMY_DISPLAY, section_dummy_display),
    (Phase.OINK_DISPLAY, section_oink_display),
    (Phase.OBS_INSTALL, section_obs_install),
    (Phase.OBS_GOLDEN, section_obs_golden),
    (Phase.OBS_IRL_SOURCE, section_obs_irl_source),
    (Phase.AITUM_PLUGINS, section_aitum_plugins),
    (Phase.OBS_WEBSOCKET, section_obs_websocket),
    (Phase.OINK_OBS, section_oink_obs),
    (Phase.OBS_SCENES, section_obs_scenes),
    (Phase.OBS_VERTICAL, section_obs_vertical),
    (Phase.OINK_VNC, section_oink_vnc),
    (Phase.GUACAMOLE, section_guacamole),
]

# Signature artifact for each phase — used to detect drift (e.g. after a
# partial cleanup) even when the state file still says "done".
_UNIT_FOR_PHASE = {
    Phase.OINK_DISPLAY: "oink-display",
    Phase.OINK_OBS: "oink-obs",
    Phase.OINK_VNC: "oink-vnc",
    Phase.GUACAMOLE: "oink-guac",
}

# Source templates each phase installs. A change here means the phase's output
# changed, so `oink setup` must re-run it even though the state flag says done.
# The fingerprint is over the *source* templates, so rendered substitutions
# (unit passwords/paths, the guac AES key) never destabilise it.
#
# Deliberately not included: the plugin-download phases (OBS_IRL_SOURCE /
# AITUM_PLUGINS) — their sections already no-op when the plugin is present, so
# fingerprinting pinned-data changes would only cause a needless OBS restart.
_PHASE_TEMPLATES: dict[Phase, tuple[str, ...]] = {
    Phase.DUMMY_DISPLAY: ("10-oink-dummy.conf",),
    Phase.OINK_DISPLAY: ("oink-display.service",),
    Phase.OBS_GOLDEN: ("user.ini.golden",),
    Phase.OINK_OBS: ("oink-obs.service", "oink-obs-maximize.sh",
                     "oink-pin-recordings.sh", "oink-firewall.sh",
                     "oink-firewall.service"),
    Phase.OBS_SCENES: ("scenes.py",),
    Phase.OBS_VERTICAL: ("vertical-canvas.json",),
    Phase.OINK_VNC: ("oink-vnc.service",),
    Phase.GUACAMOLE: ("server.js", "guac-token.js", "client.html",
                      "preview-client.html", "preview-dashboard.html",
                      "guac-package.json"),
}


def _phase_fingerprint(cfg: SetupConfig, phase: Phase) -> str:
    """sha256 of a phase's template inputs, or "" when it has none.

    Compared against the value stored in the state at completion: a mismatch
    (or a missing stored value, e.g. a pre-fingerprint state file) re-runs the
    phase so template changes deploy on an existing box.
    """
    parts = [f"{name}\0{cfg.template(name)}" for name in _PHASE_TEMPLATES.get(phase, ())]
    if not parts:
        return ""
    return hashlib.sha256("\0".join(parts).encode("utf-8")).hexdigest()


def _phase_artifacts_present(cfg: SetupConfig, phase: Phase) -> bool:
    """Cheap existence check for a phase's signature artifact(s)."""
    if phase == Phase.BASE_PACKAGES:
        return run_ok(cfg, "dpkg", "-s", "obs-studio") and all(
            run_ok(cfg, "dpkg", "-s", p) for p in (*TAR_PKGS, *BACKUP_PKGS)
        )
    if phase == Phase.OBS_USER:
        return run_ok(cfg, "getent", "passwd", cfg.obs_user)
    if phase == Phase.DUMMY_DISPLAY:
        return pathlib.Path("/etc/X11/xorg.conf.d/10-oink-dummy.conf").exists()
    if phase in _UNIT_FOR_PHASE:
        return pathlib.Path(f"/etc/systemd/system/{_UNIT_FOR_PHASE[phase]}.service").exists()
    if phase == Phase.OBS_INSTALL:
        return cfg.obs_cfg.exists()
    if phase == Phase.OBS_GOLDEN:
        return (cfg.obs_home / "user.ini.golden").exists()
    if phase == Phase.OBS_IRL_SOURCE:
        return plugin_matches(cfg.obs_cfg / "plugins" / "obs-irl-source", IRL_SOURCE["version"])
    if phase == Phase.AITUM_PLUGINS:
        plugins = cfg.obs_cfg / "plugins"
        return all(plugin_matches(plugins / p["name"], p["version"]) for p in AITUM_PLUGINS)
    if phase == Phase.OBS_WEBSOCKET:
        return (cfg.obs_ws / "password").exists()
    if phase == Phase.OBS_SCENES:
        return pathlib.Path(OINK_LIBEXEC / "oink-scenes.py").exists()
    if phase == Phase.OBS_VERTICAL:
        return (cfg.obs_cfg / "basic" / "scenes" / f"{VERTICAL_SCENE_COLLECTION}.json").exists()
    return True


def _distro_supported(distro_id: str, version: str) -> bool:
    """True when `distro_id` is known (in MIN_VERSIONS) and `version` meets the floor."""
    minimum = MIN_VERSIONS.get(distro_id)
    if minimum is None:
        return False  # unsupported distro (not just version)
    try:
        cur = tuple(int(p) for p in version.split(".")[: len(minimum.split("."))])
    except ValueError:
        return False  # empty/malformed VERSION_ID
    return cur >= tuple(int(p) for p in minimum.split("."))


_ENV_KEY_RE = re.compile(r"^OINK_[A-Z0-9_]+$")

_INGEST_KEY_RE = re.compile(r"^[A-Za-z0-9_-]{20,}$")
_OBS_USER_RE = re.compile(r"^[a-z_][a-z0-9_-]{0,31}$")
_TWITCH_CHANNEL_RE = re.compile(r"^[A-Za-z0-9_]{1,25}$")
_PRIMARY_PLATFORMS = ("twitch", "youtube", "kick")
_PLATFORM_KEYS = ("OINK_TWITCH_STREAM_KEY", "OINK_YOUTUBE_STREAM_KEY", "OINK_KICK_STREAM_KEY")
_VIDEO_PRESETS = ("720p30", "720p60", "1080p30", "1080p60", "1440p60")


def _check_oink_key(key: str, value: str) -> str | None:
    """Return a problem description for a loaded OINK_* key, or None when OK.

    Unrecognized keys are flagged (they are imported but nothing consumes them),
    which surfaces typo'd or stale names.
    """
    if key == "OINK_ADMIN_PASSWORD":
        return None if len(value) >= 8 else "too short (min 8 chars)"
    if key == "OINK_INGEST_KEY":
        return None if _INGEST_KEY_RE.match(value) else "invalid — need 20+ chars of [A-Za-z0-9_-]"
    if key == "OINK_OBS_USER":
        return None if _OBS_USER_RE.match(value) else "invalid username"
    if key == "OINK_PRIMARY_PLATFORM":
        return None if value.strip().lower() in _PRIMARY_PLATFORMS \
            else f"unknown value (want {'|'.join(_PRIMARY_PLATFORMS)})"
    if key in _PLATFORM_KEYS:
        return None if value else "empty stream key"
    if key == "OINK_TWITCH_CHANNEL":
        return None if _TWITCH_CHANNEL_RE.match(value) \
            else "invalid — 1-25 chars of letters, digits or underscore"
    if key == "OINK_VIDEO_PRESET":
        return None if value.strip() in _VIDEO_PRESETS \
            else f"unknown value (want {'|'.join(_VIDEO_PRESETS)})"
    if key == "OINK_TWITCH_BOT_USERNAME":
        return None if value else "empty"
    if key == "OINK_TWITCH_BOT_OAUTH":
        return None if value.startswith("oauth:") and len(value) > len("oauth:") \
            else "must start with oauth:<token>"
    if key == "OINK_WEB_PORT":
        problem = stack.check_web_port(value)
        return None if problem is None else "invalid — " + problem
    if key == "OINK_TRUSTED_PROXIES":
        problem = stack.check_trusted_proxies(value)
        return None if problem is None else "invalid — " + problem
    return "unrecognized key — ignored"


def _load_env_file(path: pathlib.Path) -> list[str]:
    """Load OINK_* settings from a shell-style config file into os.environ.

    Accepts `export OINK_X=Y` and `OINK_X=Y`, ignores blanks/comments, strips one
    layer of matching quotes, and splits on the first `=`. Empty values are
    treated as unset. Only OINK_* keys are imported: the setup runs as root, so
    the file must not be able to inject arbitrary environment into the privileged
    subprocesses it spawns. Real process env wins over the file. Returns the keys
    loaded (never values).
    """
    loaded: list[str] = []
    try:
        text = path.read_text()
    except OSError:
        return loaded
    for raw in text.splitlines():
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        if line.startswith("export "):
            line = line[len("export "):].lstrip()
        if "=" not in line:
            continue
        key, value = line.split("=", 1)
        key = key.strip()
        value = value.strip()
        if len(value) >= 2 and value[0] == value[-1] and value[0] in "\"'":
            value = value[1:-1]
        if not value or not _ENV_KEY_RE.match(key) or key in os.environ:
            continue
        os.environ[key] = value
        loaded.append(key)
    # Convenience alias: OINK_OBS_USER feeds models.OBS_USER.
    if "OBS_USER" not in os.environ and "OINK_OBS_USER" in os.environ:
        os.environ["OBS_USER"] = os.environ["OINK_OBS_USER"]
    return loaded


def _run_host_phase(args) -> None:
    """Host phase of `oink setup`: OBS/display/VNC/Guacamole (12 sections)."""
    cfg = SetupConfig.from_args(args)

    # ── Pre-flight ────────────────────────────────────────────────────────────
    if os.geteuid() != 0:
        bail(cfg, "Run as root (sudo).")
    if not _distro_supported(cfg.distro_id, cfg.distro_version):
        if cfg.distro_id not in MIN_VERSIONS:
            bail(cfg, f"Unsupported distro: {cfg.distro_id} (need Ubuntu 24.04+)")
        bail(cfg, f"{cfg.distro_id} {cfg.distro_version or '?'} too old — "
                  f"need {cfg.distro_id} {MIN_VERSIONS[cfg.distro_id]}+")
    info(cfg, f"Detected {cfg.distro_id} {cfg.distro_version} — "
              f"target OS: {cfg.distro_id} {MIN_VERSIONS[cfg.distro_id]}+")

    # ── Run sections ──────────────────────────────────────────────────────────
    dry_run = cfg.dry_run
    if dry_run:
        # Dry-run always shows the full flow and never writes state.
        state = HostState()
        info(cfg, "  [dry-run] State tracking disabled; showing full run")
    else:
        state = HostState.load()

    for phase, section in PHASE_SECTIONS:
        if state.is_done(phase):
            fingerprint = _phase_fingerprint(cfg, phase)
            stored = state.phase_fingerprints.get(phase.value)
            if _phase_artifacts_present(cfg, phase) and (not fingerprint or stored == fingerprint):
                info(cfg, f"{phase.section_marker}  {phase.display_name} — already done, skipping")
                continue
            reason = "inputs changed" if fingerprint and stored != fingerprint else "artifacts missing"
            info(cfg, f"{phase.section_marker}  {phase.display_name} — "
                      f"state says done but {reason}; re-running")
            state.completed_phases.discard(phase)
        info(cfg, "")
        t0 = time.time()
        result = section(cfg, state)
        if not result.success:
            bail(cfg, result.message or f"{phase.display_name} failed")
        state.mark_done(phase)
        state.phase_fingerprints[phase.value] = _phase_fingerprint(cfg, phase)
        if not dry_run:
            state.save()
        print(f"  → {phase.display_name} done in {int(time.time() - t0)}s")

    # ── Verification ──────────────────────────────────────────────────────────
    if dry_run:
        print()
        info(cfg, "════════════════════════════════════════════════════════════")
        info(cfg, "  Verification skipped (dry-run)")
        info(cfg, "════════════════════════════════════════════════════════════")
    else:
        result = verify(cfg, state)
        if not result.success:
            raise SystemExit(1)


def cmd_setup(args) -> None:
    """Run the full install: host phase, then the native-stack phase."""
    started = time.time()
    _run_host_phase(args)
    cfg = SetupConfig.from_args(
        Namespace(dry_run=args.dry_run, yes=args.yes, verbose=args.verbose)
    )
    rc = stack.stack_main(cfg)
    total = int(time.time() - started)
    print()
    info(cfg, "════════════════════════════════════════════════════════════")
    info(cfg, f"  Setup complete in {total // 60}m{total % 60:02d}s")
    info(cfg, "════════════════════════════════════════════════════════════")
    raise SystemExit(rc)


def _upgrade_install() -> int:
    """Apply the re-pinned components by re-execing `oink setup -y`, in a child
    process so constants/stack re-import with the new pins (they are read at
    import time)."""
    oink = pathlib.Path(__file__).resolve()
    return subprocess.call([sys.executable, str(oink), "setup", "-y"])


def cmd_upgrade(args) -> None:
    """Check pinned components against GitHub, then re-pin + reinstall selected."""
    check_only = getattr(args, "check", False)
    cfg = SetupConfig.from_args(Namespace(dry_run=False, yes=args.yes, verbose=False))
    if not check_only and os.geteuid() != 0:
        bail(cfg, "Run as root (sudo) to install upgrades.")
    rc = upgrade.upgrade_main(cfg, check_only=check_only, auto_yes=args.yes,
                              install=_upgrade_install)
    raise SystemExit(rc)


def cmd_cleanup(args) -> None:
    cfg = SetupConfig.from_args(
        Namespace(dry_run=args.dry_run, yes=args.yes)
    )
    raise SystemExit(cleanup.cleanup_main(cfg))


def cmd_status(args) -> None:
    cfg = SetupConfig.from_args(
        Namespace(dry_run=False, yes=True)
    )
    raise SystemExit(status.status_main(cfg, as_json=args.json))


def cmd_backup(args) -> None:
    """Create a zip of box state (users, ingest key, NOALBS, OBS scenes)."""
    if os.geteuid() != 0:
        cfg = SetupConfig.from_args(Namespace(dry_run=False, yes=False))
        bail(cfg, "Run as root (sudo).")
    cfg = SetupConfig.from_args(
        Namespace(dry_run=False, yes=True, verbose=False)
    )
    if args.out:
        out = pathlib.Path(args.out)
    else:
        stamp = time.strftime("%Y%m%d-%H%M%S")
        out = cfg.home / f"oink-backup-{stamp}.zip"
    raise SystemExit(backup.backup_main(cfg, out, encrypt=args.encrypt, assets=args.assets))


def cmd_restore(args) -> None:
    """Restore a backup archive onto this box (stops + restarts affected units)."""
    if os.geteuid() != 0:
        cfg = SetupConfig.from_args(Namespace(dry_run=False, yes=False))
        bail(cfg, "Run as root (sudo).")
    cfg = SetupConfig.from_args(
        Namespace(dry_run=args.dry_run, yes=args.yes)
    )
    raise SystemExit(backup.restore_main(cfg, pathlib.Path(args.archive), force=args.force))


def _users_path(cfg: SetupConfig) -> pathlib.Path:
    return cfg.stack_dir / "users.json"


def _pending_reset_path(cfg: SetupConfig) -> pathlib.Path:
    return cfg.stack_dir / "pending-reset.json"


def cmd_users(args) -> None:
    """Manage dashboard user accounts (box-local, for lockout recovery)."""
    cfg = SetupConfig.from_args(Namespace(dry_run=False, yes=True))

    if args.users_command == "list":
        if not _users_path(cfg).exists():
            info(cfg, "No users.json yet — the admin account is created on first "
                      "oink-api start with OINK_ADMIN_PASSWORD set.")
            raise SystemExit(0)
        try:
            store = json.loads(_users_path(cfg).read_text())
        except OSError:
            bail(cfg, "Could not read users.json")
        users = store.get("users", [])
        if not users:
            info(cfg, "No users in users.json")
            raise SystemExit(0)
        print(f"{'USERNAME':<28} {'ROLE':<10} STATUS")
        for u in sorted(users, key=lambda x: x.get("username", "")):
            if u.get("disabled"):
                status_text = "disabled"
            elif u.get("mustChangePassword"):
                status_text = "must change password"
            else:
                status_text = "active"
            print(f"{u.get('username', '?'):<28} {u.get('role', '?'):<10} {status_text}")
        raise SystemExit(0)

    if args.users_command == "reset":
        username = args.username.strip().lower()
        if getattr(args, "dry_run", False):
            info(cfg, f"  → Would stage a password reset for {username} and restart oink-api")
            raise SystemExit(0)
        import secrets

        new_password = secrets.token_urlsafe(12)
        pending = {"username": username, "password": new_password}
        _users_path(cfg).parent.mkdir(parents=True, exist_ok=True)
        _pending_reset_path(cfg).write_text(json.dumps(pending))
        os.chmod(_pending_reset_path(cfg), 0o600)
        shutil.chown(_pending_reset_path(cfg), user=cfg.obs_user, group=cfg.obs_user)
        if not run_ok(cfg, "systemctl", "restart", "oink-api"):
            bail(cfg, "Failed to restart oink-api — the reset will apply on its next start")
        info(cfg, f"Password for {username} has been reset.")
        print(f"\n  New password: {new_password}")
        info(cfg, "  This is shown once. Log in and change it from Settings → Users & access.")


def main() -> None:
    # Shared option: -c works before the subcommand (main parser) and after it
    # (each subparser inherits the parent), so `oink.py -c f setup` and
    # `oink.py setup -c f` are both valid. Subparser value wins when both given.
    _common = argparse.ArgumentParser(add_help=False)
    _common.add_argument("-c", "--config", metavar="FILE", default=argparse.SUPPRESS,
                         help="Load OINK_* settings from FILE.")

    ap = argparse.ArgumentParser(
        prog="oink.py",
        description=__doc__,
        formatter_class=argparse.RawDescriptionHelpFormatter,
        parents=[_common],
    )
    ap.add_argument("--version", action="version", version="oink.py 26.10.0")

    sub = ap.add_subparsers(
        dest="command", required=True,
        metavar="{setup,upgrade,cleanup,status,users,backup,restore}",
    )

    # setup ─────────────────────────────────────────────────────────────────────
    p_setup = sub.add_parser(
        "setup",
        help="Full install in one command: host phase (OBS/VNC/Guacamole), then the native stack.",
        parents=[_common],
    )
    p_setup.add_argument("--dry-run", action="store_true",
                         help="Print commands without executing (verification skipped).")
    p_setup.add_argument("-y", "--yes", action="store_true",
                         help="Auto-confirm all prompts (non-interactive mode).")
    p_setup.add_argument("--force", action="store_true",
                         help="With -y: skip the dedicated-box confirmation "
                              "(assume this host is already OINK-only).")
    p_setup.add_argument("-v", "--verbose", action="store_true",
                         help="Show full apt/build output (default: quiet).")
    p_setup.set_defaults(func=cmd_setup)

    # cleanup ───────────────────────────────────────────────────────────────────
    p_cln = sub.add_parser(
        "cleanup",
        help="Fully uninstall OpenIRLNodeKit from a host (services, OBS, native stack).",
        parents=[_common],
    )
    p_cln.add_argument("-y", "--yes", action="store_true",
                       help="Auto-confirm all prompts (non-interactive mode).")
    p_cln.add_argument("--dry-run", action="store_true",
                       help="Print what would happen without changing anything.")
    p_cln.set_defaults(func=cmd_cleanup)

    # status ────────────────────────────────────────────────────────────────────
    p_st = sub.add_parser(
        "status",
        help="Read-only health report: systemd units, native stack, endpoints, stack artifacts.",
        parents=[_common],
    )
    p_st.add_argument("--json", action="store_true",
                      help="Print machine-readable JSON and nothing else.")
    p_st.set_defaults(func=cmd_status)

    # users ────────────────────────────────────────────────────────────────────
    p_users = sub.add_parser(
        "users",
        help="Dashboard user accounts: list, or reset a password (lockout recovery).",
        parents=[_common],
    )
    u_sub = p_users.add_subparsers(dest="users_command", required=True, metavar="{list,reset}")
    p_u_list = u_sub.add_parser(
        "list",
        help="List dashboard users (read-only).",
    )
    p_u_list.set_defaults(func=cmd_users, username=None)
    p_u_reset = u_sub.add_parser(
        "reset",
        help="Generate a new password for a user and restart oink-api to apply it.",
    )
    p_u_reset.add_argument("username", help="Username whose password to reset (e.g. admin).")
    p_u_reset.set_defaults(func=cmd_users)

    # backup ────────────────────────────────────────────────────────────────────
    p_bak = sub.add_parser(
        "backup",
        help="Zip of box state: dashboard users, ingest key, NOALBS config, OBS scenes/profiles.",
        parents=[_common],
    )
    p_bak.add_argument("-o", "--out", metavar="FILE",
                       help="Archive path (default: ~/oink-backup-<timestamp>.zip).")
    p_bak.add_argument("--encrypt", action="store_true",
                       help="Encrypt the archive with openssl (prompts for a passphrase).")
    p_bak.add_argument("--assets", action="store_true",
                       help="Also include uploaded assets (~/dependencies) — same opt-in as the dashboard backup card.")
    p_bak.set_defaults(func=cmd_backup)

    # restore ───────────────────────────────────────────────────────────────────
    p_res = sub.add_parser(
        "restore",
        help="Restore a backup archive onto this box (stops/restarts affected units).",
        parents=[_common],
    )
    p_res.add_argument("archive", help="Backup .zip (or .zip.enc) to restore.")
    p_res.add_argument("-y", "--yes", action="store_true",
                       help="Skip the confirmation prompt.")
    p_res.add_argument("--dry-run", action="store_true",
                       help="Show what would be restored without writing anything.")
    p_res.add_argument("--force", action="store_true",
                       help="Restore despite checksum mismatches.")
    p_res.set_defaults(func=cmd_restore)

    # upgrade ───────────────────────────────────────────────────────────────────
    p_up = sub.add_parser(
        "upgrade",
        help="Check pinned components against their GitHub releases; re-pin + reinstall.",
        parents=[_common],
    )
    p_up.add_argument("--check", action="store_true",
                      help="Only report available updates (read-only, no sudo needed).")
    p_up.add_argument("-y", "--yes", action="store_true",
                      help="Upgrade every component with an update, no prompt.")
    p_up.set_defaults(func=cmd_upgrade)

    args = ap.parse_args()
    if getattr(args, "config", None):
        cfg_path = pathlib.Path(args.config)
        if not cfg_path.is_file():
            print(f"error: config file not found: {cfg_path}", file=sys.stderr)
            raise SystemExit(2)
        loaded = _load_env_file(cfg_path)
        print(f"  → Using config {cfg_path}" + (f": {', '.join(sorted(loaded))}" if loaded else ""))
        if loaded:
            width = max(len(k) for k in loaded)
            for key in sorted(loaded):
                problem = _check_oink_key(key, os.environ.get(key, ""))
                print(f"    {'✓' if problem is None else '✗'}  {key:<{width}}  {problem or 'ok'}")
    args.func(args)


if __name__ == "__main__":
    main()
