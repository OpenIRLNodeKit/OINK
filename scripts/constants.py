# SPDX-FileCopyrightText: 2026 OpenIRLNodeKit contributors
# SPDX-License-Identifier: AGPL-3.0-or-later
"""Constants for the OpenIRLNodeKit setup package."""

from __future__ import annotations

import json
import pathlib

# The host-setup state lives in scripts/state; templates in scripts/templates.
BASE_DIR = pathlib.Path(__file__).resolve().parent

# Installed entry points. `oink` is the user-facing CLI (on PATH); the helper
# scripts the systemd units drive live off-PATH in a libexec dir.
OINK_CLI = pathlib.Path("/usr/local/bin/oink")
OINK_LIBEXEC = pathlib.Path("/usr/local/libexec/oink")

# Dedicated unprivileged runtime account. OBS, Guacamole, and the deployed
# stack run as this user (not the admin `sudo` user).
OINK_GROUP = "oink"
OBS_USER = "obsuser"
OBS_HOME = pathlib.Path(f"/home/{OBS_USER}")

# Ports
OBS_WS_PORT = 4455
VNC_PORT = 5900
TUNNEL_PORT = 8080
CLIENT_PORT = 8081

# Display
DUMMY_DISPLAY = ":99"

# Package lists
BASE_PKGS = ["x11vnc", "ffmpeg"]
X11_PKGS = [
    "xserver-xorg-core", "xserver-xorg-video-dummy",
    "x11-xserver-utils", "x11-utils", "x11vnc",
]
# zip/unzip: the dashboard creates and restores backup archives as .zip
# (user-friendly downloads); the control plane shells out to these.
BACKUP_PKGS = ["zip", "unzip"]
COMMON_PKGS = [
    "ffmpeg", "curl", "ca-certificates", "git", "gnupg", "openssl",
    "fonts-dejavu-core", "xdotool", "python3-websocket",
    # GPU driver detection (nvidia-smi / ubuntu-drivers) for the dashboard's
    # encoder probe.
    "ubuntu-drivers-common",
    # OBS virtual camera. v4l2loopback-dkms builds the kernel module OBS
    # registers as "OBS Virtual Camera"; -utils ships v4l2loopback-ctl + the
    # modprobe/udev helpers. §1 loads the module after the apt pass.
    "v4l2loopback-dkms", "v4l2loopback-utils",
    *BACKUP_PKGS,
]
# tar decompressors — the dashboard's OBS plugin upload accepts .tar.gz/.tar.xz/
# .tar.bz2 and GNU tar auto-detects the format from the archive's magic bytes.
TAR_PKGS = ["xz-utils", "bzip2"]
# Native guacd (installed in the §1 apt pass, enabled by §8).
GUAC_PKGS = ["guacd", "libguac-client-vnc0t64"]
# OBS from the Ubuntu OBS PPA (added in §1 before the apt pass).
OBS_PKGS = ["obs-studio"]
# Nginx reverse proxy (distro apt package; its shipped unit is disabled by §5).
NGINX_PKGS = ["nginx"]
# fail2ban guards the dashboard login against brute force by tailing the nginx
# access log the stack configures (drop-ins written by §5).
SECURITY_PKGS = ["fail2ban", "nftables"]

# Paths
STATE_DIR = BASE_DIR / "state"
STATE_FILE = STATE_DIR / "host_state.json"
TEMPLATE_DIR = BASE_DIR / "templates"

# Timeouts
OBS_WS_TIMEOUT = 90
VERIFY_TIMEOUT = 90

# Distro requirements (OBS PPA is Ubuntu-only).
MIN_VERSIONS = {"ubuntu": "24.04"}

# ── Component manifest (default OBS plugins + pinned native binaries) ─────────
# Pinned release metadata for every component OINK downloads lives in
# stack/components.json — the SAME file log-server.js reads — so bumping a
# version is a one-file, data-only change instead of editing multiple runtimes.
#
# `plugins[]`: the plugins that ship with every build, installed by the §4c
# (§4d) host-setup phases and exposed as non-removable entries in the
# dashboard's plugin manager (download URL, sha256, packaging kind, minimum OBS).
# `binaries`: MediaMTX and NOALBS pinned GitHub release tarballs (Nginx is apt).
COMPONENTS_FILE = pathlib.Path(BASE_DIR.parent / "stack" / "components.json")
DEFAULT_PLUGINS = json.loads(COMPONENTS_FILE.read_text())
BINARY_PINS = DEFAULT_PLUGINS["binaries"]


def _plugin_meta(name: str) -> dict:
    return next(p for p in DEFAULT_PLUGINS["plugins"] if p["name"] == name)


IRL_SOURCE = _plugin_meta("obs-irl-source")
AITUM_MULTISTREAM = _plugin_meta("aitum-multistream")
AITUM_VERTICAL = _plugin_meta("vertical-canvas")
AITUM_PLUGINS = [AITUM_MULTISTREAM, AITUM_VERTICAL]
# Minimum OBS the Aitum pair supports (from the shared manifest; the floor the
# dashboard plugin manager relies on too).
AITUM_MIN_OBS = tuple(DEFAULT_PLUGINS["min_obs"])

# ── Vertical canvas (Aitum Vertical Canvas plugin) ───────────────────────────
# The host-setup §6c phase writes a golden scene-collection template that
# provisions the "Aitum Vertical" canvas with a scene per default main scene and
# links each main scene to its vertical counterpart (auto-sync via a nested
# scene source). These constants identify the canvas and the template file.
#
# Single source of truth: the canvas identity/dimensions live in
# stack/components.json (the SAME manifest log-server.js reads), so the
# Python setup and the Node control plane can never drift. Falls back to the
# committed values if the manifest key is absent.
_VERTICAL_CANVAS_DEFAULTS = {
    "name": "Aitum Vertical",
    "uuid": "0f5d712a-f8aa-44e0-acaa-1da0f9a7a645",
    "width": 1080,
    "height": 1920,
    "main_canvas_uuid": "6c69626f-6273-4c00-9d88-c5136d61696e",
    "min_obs": [31, 1],
}
_vertical_canvas = {**_VERTICAL_CANVAS_DEFAULTS, **(DEFAULT_PLUGINS.get("vertical_canvas") or {})}
VERTICAL_CANVAS_NAME = _vertical_canvas["name"]
VERTICAL_CANVAS_UUID = _vertical_canvas["uuid"]
VERTICAL_WIDTH = _vertical_canvas["width"]
VERTICAL_HEIGHT = _vertical_canvas["height"]
MAIN_CANVAS_UUID = _vertical_canvas["main_canvas_uuid"]
# Minimum OBS the vertical-canvas canvas system needs (31.1+). Drawn from the
# same manifest so the §6c gate matches the dashboard's plugin expectation.
AITUM_VERTICAL_MIN_OBS = tuple(_vertical_canvas["min_obs"])
VERTICAL_TEMPLATE = "vertical-canvas.json"
# The scene collection the golden template replaces (the default OBS collection).
VERTICAL_SCENE_COLLECTION = "oink"

# ── OBS profile ───────────────────────────────────────────────────────────────
# The name of the OBS profile the host-setup maintains. OBS stores each profile
# in basic/profiles/<name>/ and records it in the profile's user.ini [Basic]
# block (Profile/ProfileDir). Kept in sync with the scene collection name so the
# golden profile + collection resolve on every boot.
OBS_PROFILE = "oink"
