#!/usr/bin/env python3
# SPDX-FileCopyrightText: 2026 OpenIRLNodeKit contributors
# SPDX-License-Identifier: AGPL-3.0-or-later
"""stack.py — the native-stack phase of `oink setup`: builds the OpenIRLNodeKit
web dashboard, API, MediaMTX ingest, NOALBS scene switcher, and Nginx reverse
proxy as native systemd units. Nginx is distro-managed (apt `nginx`, like
guacd); MediaMTX and NOALBS are pinned GitHub release tarballs verified by
sha256 and installed under ~/oink/stack/bin.

Runs after `oink setup`'s host phase (see oink.py) from a repo checkout (needs
dashboard/, stack/, Node >= 22.12.0); the host phase guarantees guacd, VNC, and
OBS are present and generated the obs-websocket password §5 records.

Usage:
    sudo python3 oink.py setup [-y] [--dry-run]

Idempotent: safe to re-run. Only restarts a unit when its unit file actually
changed, so a re-run of the stack phase is fast and non-disruptive.
"""

from __future__ import annotations

import base64
import hashlib
import ipaddress
import json
import os
import pathlib
import re
import secrets
import shutil
import subprocess
import time

from constants import BINARY_PINS, OINK_LIBEXEC
from logui import C, bail, confirm, info, warn
from models import SetupConfig
from process import node_semver, run, run_ok, wait_check

# ── Paths ─────────────────────────────────────────────────────────────────────

_REPO_ROOT = pathlib.Path(__file__).resolve().parent.parent
_STACK_DIR = _REPO_ROOT / "stack"
_WEB_DIR = _REPO_ROOT / "dashboard"

# ── Dashboard web port ────────────────────────────────────────────────────────
# OINK_WEB_PORT (from oink.conf) selects the nginx listen port. Default 8305:
# an 8-series upstream port that embeds 305 = ASCII sum of "OINK" (79+73+78+75).
# 80/443 stay free for an external reverse proxy (TLS), and the reserved set
# also covers every port the native stack itself binds.

WEB_PORT_DEFAULT = 8305
STACK_RESERVED_PORTS = {80, 443, 1935, 8080, 8081, 8082, 8890}

# Reserved ingest label: the default monitored feed (NOALBS watches it), the
# statically declared media path, and a non-deletable profile. Was `stream`.
RESERVED_MAIN_LABEL = "irl"


def check_web_port(value: str) -> str | None:
    """Validate an OINK_WEB_PORT value; return a problem description or None."""
    try:
        port = int(value)
    except (TypeError, ValueError):
        return "must be an integer 1-65535"
    if not 1 <= port <= 65535:
        return "must be 1-65535"
    if port in STACK_RESERVED_PORTS:
        return f"{port} is already used by the stack or its reverse proxy"
    return None


def resolve_web_port(cfg: SetupConfig) -> int:
    """The dashboard listen port: OINK_WEB_PORT if valid, else the default."""
    value = os.environ.get("OINK_WEB_PORT", str(WEB_PORT_DEFAULT))
    problem = check_web_port(value)
    if problem:
        warn(cfg, f"  → OINK_WEB_PORT={value} rejected ({problem}); using {WEB_PORT_DEFAULT}")
        return WEB_PORT_DEFAULT
    return int(value)


# ── Trusted fronting proxy (OINK_TRUSTED_PROXIES) ─────────────────────────────
# The single "this box sits behind a fronting proxy" signal. When set it turns
# on nginx real-IP resolution (so the access log / fail2ban see the real client)
# and marks the dashboard session cookie Secure. `true` trusts loopback (a
# same-host TLS terminator / tunnel); otherwise a comma-separated CIDR list.
# Unset = plain-HTTP behaviour, byte-for-byte unchanged.

_TRUSTED_PROXY_TRUTHY = ("true", "1", "yes", "on")
_TRUSTED_PROXY_FALSEY = ("", "0", "false", "no", "off")


def check_trusted_proxies(value: str) -> str | None:
    """Validate an OINK_TRUSTED_PROXIES value; return a problem or None."""
    v = (value or "").strip()
    low = v.lower()
    if low in _TRUSTED_PROXY_FALSEY or low in _TRUSTED_PROXY_TRUTHY:
        return None
    for item in v.split(","):
        item = item.strip()
        if not item:
            return "empty entry in the proxy list"
        try:
            ipaddress.ip_network(item, strict=False)
        except ValueError:
            return f"invalid CIDR/IP: {item}"
    return None


def _trusted_proxies_raw() -> str:
    return os.environ.get("OINK_TRUSTED_PROXIES", "").strip()


def _trusted_proxies_enabled() -> bool:
    return _trusted_proxies_raw().lower() not in _TRUSTED_PROXY_FALSEY


def _trusted_proxy_networks() -> list[str]:
    """The proxy addresses to trust: loopback for `true`, else the CIDR list."""
    v = _trusted_proxies_raw().lower()
    if v in _TRUSTED_PROXY_TRUTHY:
        return ["127.0.0.1", "::1"]
    return [n.strip() for n in _trusted_proxies_raw().split(",") if n.strip()]


def _trusted_proxy_block() -> str:
    """nginx real-IP directives for the fronting proxy, or '' when unset."""
    if not _trusted_proxies_enabled():
        return ""
    lines = [
        "    # Resolve the real client from the fronting proxy's X-Forwarded-For",
        "    # (stack/nginx.conf overwrites the header with $remote_addr upstream).",
        "    real_ip_header X-Forwarded-For;",
        "    real_ip_recursive on;",
    ]
    lines += [f"    set_real_ip_from {n};" for n in _trusted_proxy_networks()]
    return "\n".join(lines)


def _render_fail2ban_jail(cfg: SetupConfig) -> str:
    """Render the fail2ban jail template (tmp dir, web port, proxy ignore list)."""
    ignore = " ".join(_trusted_proxy_networks()) if _trusted_proxies_enabled() else ""
    return cfg.template("oink-fail2ban-jail.local") \
        .replace("__TMP_DIR__", str(cfg.stack_dir / "nginx-tmp")) \
        .replace("__OINK_WEB_PORT__", str(resolve_web_port(cfg))) \
        .replace("__TRUSTED_PROXY_IGNORE__", ignore)


_CSP_INLINE_SCRIPT_RE = re.compile(
    r"<script\b(?![^>]*\bsrc=)[^>]*>(.*?)</script>", re.IGNORECASE | re.DOTALL)


def _csp_script_src(web_root: pathlib.Path) -> str:
    """script-src for the installed SPA: 'self' plus a sha256 for every inline
    bootstrap script in index.html. Computed per `oink setup` so it tracks the
    built assets; falls back to 'unsafe-inline' only when index.html is absent
    (dry-run/pre-build) so a render never emits a broken CSP."""
    index = web_root / "index.html"
    if not index.is_file():
        return "'self' 'unsafe-inline'"
    html = index.read_text(encoding="utf-8", errors="replace")
    hashes = []
    for match in _CSP_INLINE_SCRIPT_RE.finditer(html):
        digest = hashlib.sha256(match.group(1).encode("utf-8")).digest()
        hashes.append("'sha256-" + base64.b64encode(digest).decode("ascii") + "'")
    return " ".join(["'self'", *hashes])


def _render_nginx_cfg(web_root: pathlib.Path, tmp_root: pathlib.Path,
                      obs_user: str, web_port: int) -> str:
    """Render the nginx.conf template with host-specific values substituted."""
    hsts = ('    add_header Strict-Transport-Security "max-age=31536000" always;'
            if _trusted_proxies_enabled() else "")
    return (_STACK_DIR / "nginx.conf").read_text() \
        .replace("__WEB_ROOT__", str(web_root)) \
        .replace("__TMP_DIR__", str(tmp_root)) \
        .replace("__OINK_USER__", obs_user) \
        .replace("__OINK_WEB_PORT__", str(web_port)) \
        .replace("__TRUSTED_PROXY_BLOCK__", _trusted_proxy_block()) \
        .replace("__HSTS_HEADER__", hsts) \
        .replace("__CSP_SCRIPT_SRC__", _csp_script_src(web_root)) \
        .replace("__CSP_STYLE_SRC__", "'self'")


def _set_env_line(text: str, key: str, value: str) -> str:
    """Set KEY=VALUE in a dotenv-style text, replacing an existing line or appending."""
    prefix = f"{key}="
    lines = text.splitlines()
    for i, line in enumerate(lines):
        if line.strip().startswith(prefix):
            lines[i] = f"{key}={value}"
            break
    else:
        lines.append(f"{key}={value}")
    return "\n".join(lines) + "\n"

# ── Sections ──────────────────────────────────────────────────────────────────

def section1_prereqs(cfg: SetupConfig) -> None:
    """§1  Verify prerequisites."""
    info(cfg, "§1  Checking prerequisites…")

    # Stack dir (repo checkout)
    if not _STACK_DIR.exists():
        bail(cfg, f"Stack dir not found: {_STACK_DIR}")
    info(cfg, f"  → Stack dir: {_STACK_DIR}")

    # systemd present (units are installed below)
    if not pathlib.Path("/run/systemd/system").is_dir():
        bail(cfg, "systemd not running — the native stack needs systemd.")
    info(cfg, "  → systemd OK")

    # The remaining gates are read-only probes, but `run()` short-circuits under
    # --dry-run (no output), so their results would be empty. Don't fail the
    # dry-run on that — the real run enforces them.
    if cfg.dry_run:
        info(cfg, "  [dry-run] Node.js/npm/lockfile/obs-websocket gates are checked on a real run")
        return

    # Node.js (React Router requires >= 22.12.0) — always run
    r = run(cfg, "node", "--version", capture=True, check=False)
    node_ver = (r.stdout or "").strip()
    if r.returncode != 0 or not node_ver:
        bail(cfg, "Node.js not found. Install Node.js 22.x (e.g. via NodeSource): "
             "curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash - "
             "&& sudo apt-get install -y nodejs")
    semver = node_semver(cfg)
    if semver is None or semver < (22, 12, 0):
        bail(
            cfg,
            f"Node.js {node_ver} too old — React Router needs >= 22.12.0. "
            "Install Node 22.x: curl -fsSL https://deb.nodesource.com/setup_22.x | "
            "sudo -E bash - && sudo apt-get install -y nodejs",
        )
    info(cfg, f"  → Node.js {node_ver} OK")

    # npm (always run)
    r = run(cfg, "npm", "--version", capture=True, check=False)
    if r.returncode != 0 or not (r.stdout or "").strip():
        bail(cfg, "npm not found. Install Node.js 22.x (which bundles npm).")
    info(cfg, f"  → npm {(r.stdout or '').strip()} OK")

    # package-lock.json — required by `npm ci` in §2
    lockfile = _WEB_DIR / "package-lock.json"
    if not lockfile.exists():
        bail(cfg, f"Missing {lockfile}. Commit the lockfile — npm ci requires it.")
    info(cfg, f"  → Lockfile OK ({lockfile.name})")

    # obs-websocket password — generated by `oink setup`'s host phase §5,
    # wired into NOALBS §4b
    if not _obs_ws_password(cfg):
        bail(cfg, "obs-websocket password not found — run `sudo python3 oink.py setup` "
             f"first (its host phase generates {cfg.obs_ws / 'password'}).")
    info(cfg, "  → obs-websocket password OK")

def section2_build_dashboard(cfg: SetupConfig) -> None:
    """§2  Build React Router SPA dashboard."""
    info(cfg, "§2  Building dashboard…")

    dist_dir = _WEB_DIR / "build" / "client"
    package_json = _WEB_DIR / "package.json"

    if not package_json.exists():
        bail(cfg, "dashboard/package.json not found. Is the repo cloned?")

    node_modules = _WEB_DIR / "node_modules"
    if node_modules.exists():
        info(cfg, "  → node_modules exists, skipping npm ci")
    else:
        if not confirm(cfg, "Install npm dependencies (npm ci)?"):
            info(cfg, "  → Skipping npm install")
        else:
            info(cfg, "  → Installing npm dependencies (npm ci)…")
            run(cfg, "npm", "ci", cwd=str(_WEB_DIR))

    info(cfg, "  → Building React Router SPA…")
    if cfg.verbose:
        run(
            cfg,
            "npm", "run", "build",
            cwd=str(_WEB_DIR),
        )
    else:
        run(
            cfg,
            "npm", "run", "build", "--", "-l", "warn",
            cwd=str(_WEB_DIR),
        )

    if not cfg.dry_run:
        # Count output files
        if dist_dir.exists():
            count = sum(1 for _ in dist_dir.rglob("*") if _.is_file())
            info(cfg, f"  → Built {count} files to {dist_dir}")

def section3_install_web(cfg: SetupConfig) -> None:
    """§3  Install dashboard web (Nginx config + static files)."""
    info(cfg, "§3  Installing dashboard web…")

    stack_home = cfg.stack_dir

    # Create directory structure
    if not cfg.dry_run:
        (stack_home / "web").mkdir(parents=True, exist_ok=True)

    # Copy dist files
    dist_src = _WEB_DIR / "build" / "client"
    dist_dst = stack_home / "web" / "build" / "client"

    if not cfg.dry_run:
        if dist_dst.exists():
            shutil.rmtree(dist_dst)
        shutil.copytree(dist_src, dist_dst)
        info(cfg, f"  → Copied dashboard to {dist_dst}")
    else:
        info(cfg, f"  → Would copy {dist_src} → {dist_dst}")

    # Copy nginx.conf (native Nginx serves the installed SPA from its own home;
    # the repo template carries __WEB_ROOT__ / __TMP_DIR__ / __OINK_USER__ /
    # __OINK_WEB_PORT__ placeholders for the installed SPA path, the
    # obs_user-owned scratch dir, the runtime user, and the dashboard port).
    nginx_dst = stack_home / "nginx.conf"
    web_root = dist_dst
    tmp_root = stack_home / "nginx-tmp"
    web_port = resolve_web_port(cfg)
    if not cfg.dry_run:
        # Scratch dirs for the non-root nginx workers (client_body/proxy temps).
        # Pre-create the subdirs here so the recursive chown in §5 hands them to
        # the runtime user; nginx creates them root-owned at startup otherwise,
        # which the dropped workers cannot write.
        tmp_root.mkdir(parents=True, exist_ok=True)
        (tmp_root / "client_body").mkdir(exist_ok=True)
        (tmp_root / "proxy").mkdir(exist_ok=True)
        # fail2ban's jail (installed §5, before oink-nginx starts) treats a
        # missing logpath as fatal; pre-create the access log so the file exists
        # regardless of start order. nginx appends to it.
        (tmp_root / "oink-access.log").touch()
        nginx_text = _render_nginx_cfg(web_root, tmp_root, cfg.obs_user, web_port)
        changed = not nginx_dst.exists() or nginx_dst.read_text() != nginx_text
        nginx_dst.write_text(nginx_text)
        # The unit only restarts when its unit file changes, so a config-only
        # edit (CSP hashes, headers, ports) would otherwise sit inert until the
        # next reboot. Reload in place when the rendered config actually changed.
        if changed and _unit_active(cfg, "oink-nginx"):
            info(cfg, "  → Reloading oink-nginx (config changed)…")
            run(cfg, "systemctl", "reload", "oink-nginx", check=False)
        info(cfg, f"  → Copied nginx.conf (web root {web_root})")
    else:
        info(cfg, f"  → Would copy {_STACK_DIR / 'nginx.conf'} (web root {web_root})")

# ── Ingest stream key (per-install secret, live/<key>/ namespace) ────────────

def _bootstrap_ingest(cfg: SetupConfig) -> str | None:
    """Ensure the ingest stream key and render installed mediamtx.yml by
    delegating to stack/ingest.js — the single owner of ingest.json and the
    mediamtx render (rotation lives there too). Returns the key, or None + a
    [DRY] line in dry-run (callers must not write configs)."""
    cmd = ["node", str(_STACK_DIR / "ingest.js"), "bootstrap",
           str(cfg.stack_dir), str(_STACK_DIR / "mediamtx.yml")]
    if cfg.dry_run:
        info(cfg, "  → Would run: " + " ".join(cmd)
             + (" <OINK_INGEST_KEY>" if os.environ.get("OINK_INGEST_KEY") else ""))
        return None
    seed = os.environ.get("OINK_INGEST_KEY")
    if seed:
        if re.fullmatch(r"[A-Za-z0-9_-]{20,}", seed):
            cmd.append(seed)
        else:
            warn(cfg, "  → OINK_INGEST_KEY invalid (need 20+ chars of [A-Za-z0-9_-]); "
                      "generating a random ingest key")
    r = run(cfg, *cmd, capture=True, check=False)
    if r.returncode != 0 or not (r.stdout or "").strip():
        bail(cfg, f"ingest key bootstrap failed: {(r.stderr or '').strip() or f'exit {r.returncode}'}")
    try:
        return json.loads(r.stdout)["key"]
    except (ValueError, KeyError, TypeError) as e:
        bail(cfg, f"ingest key bootstrap returned invalid output: {e}")


def section4_install_ingest(cfg: SetupConfig) -> None:
    """§4  Install MediaMTX ingest server (keyed config)."""
    info(cfg, "§4  Installing MediaMTX…")

    # Seed the ingest-profile list (with the reserved monitored feed) so
    # reads/backup have a stable file; the dashboard writes it via PUT
    # /api/ingest/profiles. The reserved `irl` profile is non-deletable.
    profiles_file = cfg.stack_dir / "profiles.json"
    if not cfg.dry_run and not profiles_file.exists():
        profiles_file.write_text(
            json.dumps({
                "version": 1,
                "profiles": [RESERVED_MAIN_LABEL],
                "main": RESERVED_MAIN_LABEL,
                "updatedAt": 0,
            }, indent=2) + "\n")
        profiles_file.chmod(0o600)
        info(cfg, "  → Seeded profiles.json")

    key = _bootstrap_ingest(cfg)
    if key:
        info(cfg, f"  → Installed mediamtx.yml (stream-keyed namespace live/{key}/…)")

def _obs_ws_password(cfg: SetupConfig) -> str:
    """Read the obs-websocket password generated by `oink setup`'s host phase §5."""
    pw_file = cfg.obs_ws / "password"
    try:
        pw = pw_file.read_text().strip()
    except FileNotFoundError:
        pw = ""
    return pw

def _existing_switcher_values(cfg_json: pathlib.Path) -> dict:
    """Read the dashboard-editable NOALBS switcher fields from an installed config.

    Returns {} when the file is missing/unreadable/unparseable so a first install
    (or a hand-edited/corrupt file) falls back to the template. Only the three
    fields the dashboard owns are read — template-owned OINK fields (keyed
    statsUrl, software.password, chat.*) are never preserved.
    """
    try:
        data = json.loads(cfg_json.read_text())
        sw = data.get("switcher") or {}
        trg = sw.get("triggers") or {}
        saved: dict = {}
        if isinstance(sw.get("bitrateSwitcherEnabled"), bool):
            saved["bitrateSwitcherEnabled"] = sw["bitrateSwitcherEnabled"]
        for k in ("low", "offline"):
            v = trg.get(k)
            if isinstance(v, (int, float)) and not isinstance(v, bool):
                saved.setdefault("triggers", {})[k] = v
        return saved
    except (OSError, ValueError, AttributeError):
        return {}


def _installed_main_feed(stack_home: pathlib.Path) -> str:
    """The monitored feed label stored in profiles.json (reserved `irl` default)."""
    try:
        data = json.loads((stack_home / "profiles.json").read_text())
        if isinstance(data, dict):
            main = data.get("main")
            profiles = data.get("profiles", [])
            if isinstance(main, str) and (main == RESERVED_MAIN_LABEL or main in profiles):
                return main
    except (OSError, ValueError):
        pass
    return RESERVED_MAIN_LABEL


def _preserve_user_switcher(data: dict, saved: dict) -> bool:
    """Overlay preserved dashboard switcher values onto a rendered config dict."""
    if not saved:
        return False
    sw = data.setdefault("switcher", {})
    if "bitrateSwitcherEnabled" in saved:
        sw["bitrateSwitcherEnabled"] = saved["bitrateSwitcherEnabled"]
    if saved.get("triggers"):
        sw.setdefault("triggers", {}).update(saved["triggers"])
    return True


def section4b_install_noalbs(cfg: SetupConfig) -> None:
    """§4b  Install NOALBS config, wiring in the OBS websocket password + keyed
    ingest statsUrl.

    The repo never ships a NOALBS config that could carry credentials — only
    two templates are tracked in stack/noalbs/: config.template (the OINK
    starter config with an empty password placeholder and a
    `live/__STREAM_KEY__/irl` statsUrl) and .env.example (the dotenv that
    holds the platform chat credentials). This step renders config.json from
    config.template and copies .env.example → .env into `~/oink/stack/noalbs`,
    then patches in the generated obs-websocket password and keyed ingest URL.
    An existing installed .env is preserved across re-runs so operator-set
    chat credentials are never clobbered.
    """
    info(cfg, "§4b Installing NOALBS…")

    stack_home = cfg.stack_dir
    noalbs_src = _STACK_DIR / "noalbs"
    noalbs_dst = stack_home / "noalbs"

    if not noalbs_src.is_dir():
        bail(cfg, f"noalbs config dir not found: {noalbs_src}")

    cfg_template = noalbs_src / "config.template"
    if not cfg_template.is_file():
        bail(cfg, f"noalbs config template not found: {cfg_template}")

    pw = _obs_ws_password(cfg)

    if cfg.dry_run:
        info(cfg, f"  → Would render {cfg_template} → {noalbs_dst / 'config.json'}")
        info(cfg, f"  → Would copy {noalbs_src / '.env.example'} → {noalbs_dst / '.env'}")
        info(cfg, f"  → Would set software.password ({len(pw)} chars)")
        info(cfg, f"  → Would set statsUrl to the keyed live/<key>/{_installed_main_feed(stack_home)} path")
        return

    key = _bootstrap_ingest(cfg)
    noalbs_dst.mkdir(parents=True, exist_ok=True)

    # .env: ship the dotenv (oink-noalbs.service cwd = this dir) but never
    # clobber operator-set chat credentials on re-runs.
    env_example = noalbs_src / ".env.example"
    env_dst = noalbs_dst / ".env"
    bot_user = os.environ.get("OINK_TWITCH_BOT_USERNAME")
    bot_oauth = os.environ.get("OINK_TWITCH_BOT_OAUTH")
    if not env_dst.exists() and env_example.is_file():
        text = env_example.read_text()
        if bot_user:
            text = _set_env_line(text, "TWITCH_BOT_USERNAME", bot_user)
        if bot_oauth:
            text = _set_env_line(text, "TWITCH_BOT_OAUTH", bot_oauth)
        env_dst.write_text(text)
        env_dst.chmod(0o600)
        info(cfg, f"  → Created {env_dst} from .env.example (mode 0600)")

    cfg_json = noalbs_dst / "config.json"
    try:
        data = json.loads(cfg_template.read_text())
        if pw:
            data.setdefault("software", {})["password"] = pw
            info(cfg, "  → wired OBS websocket password into NOALBS config")
        else:
            warn(cfg, "  → OBS ws password file missing; NOALBS will fail to auth to OBS")
        if bot_user:
            data.setdefault("chat", {})["username"] = bot_user
            info(cfg, "  → wired Twitch bot username into NOALBS config")
        # Point the drop-protection stats poll at the *monitored* feed (stored in
        # profiles.json, reserved `irl` by default). statsUrl contract mirrors
        # stack/ingest.js noalbsStatsUrl() (single key owner).
        main_feed = _installed_main_feed(stack_home)
        for server in data.setdefault("switcher", {}).get("streamServers", []):
            stats = server.get("streamServer", {})
            if stats.get("type") == "Mediamtx" or "paths/get/" in stats.get("statsUrl", ""):
                stats["statsUrl"] = f"http://127.0.0.1:9997/v3/paths/get/live/{key}/{main_feed}"
                info(cfg, f"  → wired keyed ingest statsUrl ({main_feed}) into NOALBS config")
                break
        # Carry dashboard-saved switcher settings across re-runs (preserve after
        # the keyed statsUrl wiring so a stale saved statsUrl can never win).
        if _preserve_user_switcher(data, _existing_switcher_values(cfg_json)):
            info(cfg, "  → preserved dashboard switcher settings (enabled/low/offline)")
        cfg_json.write_text(json.dumps(data, indent=2) + "\n")
        # config.json carries software.password (obs-websocket); keep it 0600
        # like api.env so the secret isn't world-readable on disk.
        cfg_json.chmod(0o600)
        info(cfg, f"  → Rendered {cfg_json} from {cfg_template.name}")
    except Exception as e:
        warn(cfg, f"  → could not patch {cfg_json}: {e}")


# ── Native binaries ───────────────────────────────────────────────────────────

def _sha256_file(path: pathlib.Path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(65536), b""):
            h.update(chunk)
    return h.hexdigest()


def _find_binary_file(root: pathlib.Path, name: str) -> pathlib.Path | None:
    """Locate the binary named `name` under an extracted tarball tree.

    MediaMTX release tarballs put the binary at the top level; the NOALBS musl
    tarball nests it under a versioned directory. Reject directories and
    zero-length files so we never install a stub.
    """
    for p in root.rglob(name):
        if p.is_file() and p.stat().st_size > 0:
            return p
    return None


def _download_binary(cfg: SetupConfig, bin_dir: pathlib.Path,
                     name: str, meta: dict) -> None:
    """Fetch + verify the pinned binary and record its own sha256 marker."""
    exe = bin_dir / name
    marker = bin_dir / f"{name}.sha256"

    # Skip only when the installed file matches the *pinned* sha256 — so bumping
    # the pin in stack/components.json forces a re-download.
    if exe.exists() and _sha256_file(exe) == meta["sha256"]:
        info(cfg, f"  → {name} {meta['version']} already present and verified, skipping download")
        return
    if cfg.dry_run:
        info(cfg, f"  → Would download {name} from {meta['url']}")
        return

    if not confirm(cfg, f"Download pinned {name} binary (~{meta.get('size', '?')} MiB)?"):
        info(cfg, f"  → Skipping {name} binary download")
        return

    info(cfg, f"  → Downloading {name}…")
    bin_dir.mkdir(parents=True, exist_ok=True)
    tmp_tar = bin_dir / f".{name}.download.tar.gz"
    run(cfg, "curl", "-fsSL", meta["url"], "-o", str(tmp_tar))
    if not tmp_tar.exists():
        bail(cfg, f"Download failed for {name} — check network and the pinned URL above.")

    got = _sha256_file(tmp_tar)
    if got != meta["sha256"]:
        tmp_tar.unlink(missing_ok=True)
        bail(cfg, f"sha256 mismatch for {name}: expected {meta['sha256']}, got {got}")

    tmp_dir = bin_dir / f".{name}.extract"
    if tmp_dir.exists():
        shutil.rmtree(tmp_dir)
    tmp_dir.mkdir(parents=True)
    run(cfg, "tar", "-xzf", str(tmp_tar), "-C", str(tmp_dir))

    src = _find_binary_file(tmp_dir, name)
    if src is None:
        shutil.rmtree(tmp_dir, ignore_errors=True)
        tmp_tar.unlink(missing_ok=True)
        bail(cfg, f"Could not find `{name}` binary inside the release tarball")

    exe.write_bytes(src.read_bytes())
    exe.chmod(0o755)
    marker.write_text(_sha256_file(exe) + "\n")
    tmp_tar.unlink(missing_ok=True)
    shutil.rmtree(tmp_dir, ignore_errors=True)
    info(cfg, f"  → Installed {name} → {exe} (sha256 verified)")


# ── Native systemd units ──────────────────────────────────────────────────────

def _render_unit(cfg: SetupConfig, template_name: str) -> str:
    """Render a systemd unit template with host-specific values substituted."""
    text = cfg.template(template_name)
    replacements = {
        "$OINK_USER": cfg.obs_user,
        "$OBS_HOME": str(cfg.obs_home),
        "$STACK_DIR": str(cfg.stack_dir),
        "$OBS_LOG_DIR": str(cfg.obs_cfg / "logs"),
        "$OBS_ASSET_DIR": str(cfg.dep_dir),
        "$OBS_RECORDING_DIR": str(cfg.recording_dir),
    }
    for key, value in replacements.items():
        text = text.replace(key, value)
    return text


def _unit_path(name: str) -> pathlib.Path:
    return pathlib.Path(f"/etc/systemd/system/{name}.service")


def _unit_active(cfg: SetupConfig, unit: str) -> bool:
    return run_ok(cfg, "systemctl", "is-active", "--quiet", unit)


def section5_install_stack(cfg: SetupConfig) -> None:
    """§5  Install binaries, configs, units; converge the native stack."""
    info(cfg, "§5  Installing native stack…")

    stack_home = cfg.stack_dir
    bin_dir = stack_home / "bin"
    if not cfg.dry_run:
        bin_dir.mkdir(parents=True, exist_ok=True)

    # ── Binaries ──────────────────────────────────────────────────────────────
    for name in ("mediamtx", "noalbs"):
        _download_binary(cfg, bin_dir, name, BINARY_PINS[name])

    # ── Nginx (apt) ──────────────────────────────────────────────────────────
    # Nginx is installed in §1 with the other base packages. The distro ships
    # its own nginx.service bound to the packaged /etc/nginx.conf and enables
    # it on install; the stack overrides that with its own unit + config, so
    # stop+disable the distro unit to keep a second master from fighting
    # oink-nginx for the dashboard port.
    if not cfg.dry_run:
        if not run_ok(cfg, "dpkg", "-s", "nginx"):
            bail(cfg, "nginx package not installed — rerun `sudo python3 oink.py setup`.")
        run(cfg, "systemctl", "stop", "nginx.service", check=False)
        run(cfg, "systemctl", "disable", "nginx.service", check=False)
        info(cfg, "  → Nginx apt binary present; distro nginx.service disabled")

    # ── host-info.json (NVENC availability + pinned binary versions) ────────
    host_info = {
        "hasNvenc": _detect_nvenc(cfg),
        "versions": {name: meta["version"] for name, meta in BINARY_PINS.items()},
    }
    host_info_dst = stack_home / "host-info.json"
    if cfg.dry_run:
        info(cfg, f"  → Would write host-info.json (hasNvenc={host_info['hasNvenc']})")
    else:
        host_info_dst.write_text(json.dumps(host_info) + "\n")
        info(cfg, f"  → Wrote host-info.json (hasNvenc={host_info['hasNvenc']})")

    # ── log-server sources + deps (native node_modules, not an image build) ──
    # Ship every non-test JS module log-server.js requires (errors/config/assets/
    # recordings/plugins/obs-bridge/...) so the split source tree deploys whole.
    force_restart: set[str] = set()
    api_changed = False
    guac_modules_changed = False
    # Ship non-test .js + .json data files (plugins.js reads components.json
    # from the deployed stack dir); rendered configs/noalbs have their own steps.
    srcs = [p.name for p in sorted(_STACK_DIR.iterdir())
            if (p.suffix == ".js" and not p.name.endswith(".test.js"))
            or p.suffix == ".json"]
    for f in srcs:
        src = _STACK_DIR / f
        dst = stack_home / f
        if cfg.dry_run:
            info(cfg, f"  → Would copy {src} → {dst}")
        elif not dst.exists() or dst.read_bytes() != src.read_bytes():
            shutil.copy2(src, dst)
            api_changed = True
            # oink-guac requires these from the stack dir at startup, so it must
            # reload when they change (e.g. the fresh-read fix in auth.js) or an
            # upgrade keeps running the old module until a manual restart.
            if f in ("auth.js", "assets.js"):
                guac_modules_changed = True
            info(cfg, f"  → Updated {f}")
    node_modules = stack_home / "node_modules"
    if not cfg.dry_run and (api_changed or not node_modules.exists()):
        info(cfg, "  → Installing log-server npm deps (npm install --omit=dev)…")
        run(cfg, "npm", "install", "--omit=dev", "--no-audit", "--no-fund",
            cwd=str(stack_home))
    if api_changed:
        force_restart.add("oink-api")
    if guac_modules_changed and not cfg.dry_run and _unit_active(cfg, "oink-guac"):
        info(cfg, "  → Restarting oink-guac (auth/assets module changed)…")
        run(cfg, "systemctl", "restart", "oink-guac", check=False)

    # ── Control-plane auth secrets (dashboard login, api.env) ────────────────
    # log-server.js gates the /api/* control plane behind a signed session-cookie
    # login when BOTH secrets are present. OINK_ADMIN_PASSWORD is the one-time
    # bootstrap seed for the admin account (hashed by log-server on first boot,
    # never re-read after); OINK_SESSION_SECRET signs the HMAC session cookies.
    # Provision both into a 0600 env file the unit loads via EnvironmentFile.
    # Honour operator-supplied overrides; keep existing generated values stable
    # across re-runs so setups don't rotate credentials.
    api_env = stack_home / "api.env"
    env_values: dict[str, str] = {}
    if api_env.exists():
        try:
            for ln in api_env.read_text().splitlines():
                if "=" in ln:
                    key, value = ln.split("=", 1)
                    env_values[key.strip()] = value.strip()
        except OSError:
            env_values = {}
    admin_pw = os.environ.get("OINK_ADMIN_PASSWORD") or env_values.get("OINK_ADMIN_PASSWORD")
    if admin_pw:
        origin = "provided"
    else:
        admin_pw = secrets.token_urlsafe(18)
        origin = "generated"
    session_secret = env_values.get("OINK_SESSION_SECRET") or secrets.token_urlsafe(32)
    # OINK_ADMIN_PASSWORD_ORIGIN records whether the seed was operator-chosen
    # ("provided") or auto-generated ("generated"). log-server.js sets the first-login
    # mustChangePassword flag from it: generated seeds are shown once and must be
    # rotated, operator-provided seeds are trusted.
    # Platform stream outputs are seeded to the API (via systemd EnvironmentFile)
    # on the first boot after install; the dashboard owns them afterwards. Keep
    # any already-provisioned value when the current run doesn't supply one.
    seed_lines = ""
    for key in ("OINK_PRIMARY_PLATFORM", "OINK_TWITCH_CHANNEL",
                "OINK_VIDEO_PRESET",
                "OINK_TWITCH_STREAM_KEY",
                "OINK_YOUTUBE_STREAM_KEY", "OINK_KICK_STREAM_KEY"):
        value = os.environ.get(key) or env_values.get(key)
        if value:
            seed_lines += f"{key}={value}\n"
    # Trusted fronting proxy (real client IP + Secure cookies + fail2ban).
    # Preserve whatever is already provisioned when this run doesn't set it.
    # Collapse whitespace: systemd EnvironmentFile / dotenv split unquoted values
    # on spaces, so `10.0.0.0/8, 192.168.0.0/16` must be written comma-joined.
    trusted = _trusted_proxies_raw() or env_values.get("OINK_TRUSTED_PROXIES", "")
    trusted = ",".join(p.strip() for p in trusted.split(",") if p.strip())
    trusted_lines = f"OINK_TRUSTED_PROXIES={trusted}\n" if trusted else ""
    api_env_lines = (
        f"OINK_ADMIN_PASSWORD={admin_pw}\n"
        f"OINK_ADMIN_PASSWORD_ORIGIN={origin}\n"
        f"OINK_SESSION_SECRET={session_secret}\n"
        f"OINK_WEB_PORT={resolve_web_port(cfg)}\n"
        f"{trusted_lines}"
        f"{seed_lines}"
    )
    if cfg.dry_run:
        info(cfg, "  → Would provision api.env (dashboard control-plane auth: admin seed + session secret)")
    else:
        api_env_changed = not api_env.exists() or api_env.read_text() != api_env_lines
        api_env.write_text(api_env_lines)
        api_env.chmod(0o600)
        if api_env_changed:
            force_restart.add("oink-api")
            # oink-guac reads the session secret from api.env at startup to gate
            # the remote desktop / preview pages. Restart it only when api.env
            # actually changed (secret rotation) — a needless restart drops live
            # remote/preview sessions. User-store staleness is handled in
            # auth.js currentUser (fresh read), so no restart is needed for that.
            if _unit_active(cfg, "oink-guac"):
                run(cfg, "systemctl", "restart", "oink-guac", check=False)
        info(cfg, "  → Provisioned api.env (mode 0600, dashboard control-plane auth)")

    # ── Re-assert OBS recording path ─────────────────────────────────────────
    info(cfg, "  → Pinning OBS recording path…")
    run(cfg, "sh", str(OINK_LIBEXEC / "oink-pin-recordings.sh"), str(cfg.recording_dir), check=False)
    # The pin script rewrites basic.ini; run as root here, it would leave the
    # files root-owned and the obsuser-run OBS (and dashboard restore) could no
    # longer write them. Hand the profile tree back to the runtime user.
    if not cfg.dry_run:
        run(cfg, "chown", "-R", f"{cfg.obs_user}:{cfg.obs_user}",
            str(cfg.obs_cfg / "basic" / "profiles"), check=False)

    # Hand the stack tree to the runtime user (units below run as obsuser).
    if not cfg.dry_run:
        run(cfg, "chown", "-R", f"{cfg.obs_user}:{cfg.obs_user}", str(stack_home))

    # ── polkit: dashboard service control for the runtime user ───────────────
    # The API (as obsuser) drives systemctl for oink-mediamtx/oink-noalbs and
    # reads their logs via journalctl; grant exactly that, nothing more.
    # Note: polkitd only reads *.rules files in /etc/polkit-1/rules.d.
    polkit_dir = pathlib.Path("/etc/polkit-1/rules.d")
    polkit_file = polkit_dir / "10-oink-service-control.rules"
    polkit_text = cfg.template("oink-service-control.rules").replace(
        "$OINK_USER", cfg.obs_user)
    polkit_written = False
    if cfg.dry_run:
        info(cfg, f"  → Would write {polkit_file}")
        info(cfg, "  → Would restart polkit to load the rule")
    elif not polkit_file.exists() or polkit_file.read_text() != polkit_text:
        polkit_dir.mkdir(parents=True, exist_ok=True)
        polkit_file.write_text(polkit_text)
        polkit_written = True
        info(cfg, f"  → Wrote {polkit_file}")
    # polkitd only loads rules present at (re)load time; on a fresh boot it
    # starts before the stack phase runs, so restart it whenever we wrote the rule.
    if polkit_written:
        if run_ok(cfg, "systemctl", "restart", "polkit"):
            info(cfg, "  → Restarted polkit (rule loaded)")
        else:
            info(cfg, "  → Restarting polkitd instead (no polkit.service)")
            run(cfg, "systemctl", "restart", "polkitd", check=False)

    # ── fail2ban: ban dashboard-login brute force (tails the nginx log) ──────
    # Nginx writes a combined-format access log with the real client IP; fail2ban
    # bans repeated 401/403s on the login route. Drop-ins are written only on
    # change, like the polkit rule, so a re-run doesn't restart fail2ban.
    f2b_filter = pathlib.Path("/etc/fail2ban/filter.d/oink-auth.conf")
    f2b_jail = pathlib.Path("/etc/fail2ban/jail.d/oink-auth.local")
    logrotate_conf = pathlib.Path("/etc/logrotate.d/oink-nginx")
    logrotate_text = cfg.template("oink-logrotate.conf").replace(
        "__TMP_DIR__", str(stack_home / "nginx-tmp"))
    f2b_files = (
        (f2b_filter, cfg.template("oink-fail2ban-filter.conf")),
        (f2b_jail, _render_fail2ban_jail(cfg)),
        (logrotate_conf, logrotate_text),
    )
    if cfg.dry_run:
        info(cfg, f"  → Would write {f2b_filter}")
        info(cfg, f"  → Would write {f2b_jail}")
        info(cfg, f"  → Would write {logrotate_conf}")
        info(cfg, "  → Would enable + restart fail2ban")
    elif not run_ok(cfg, "dpkg", "-s", "fail2ban"):
        warn(cfg, "  → fail2ban not installed (was §1's apt pass declined?); login bans disabled")
    else:
        f2b_changed = False
        for path, text in f2b_files:
            path.parent.mkdir(parents=True, exist_ok=True)
            if not path.exists() or path.read_text() != text:
                path.write_text(text)
                f2b_changed = True
                info(cfg, f"  → Wrote {path}")
        run(cfg, "systemctl", "enable", "fail2ban", check=False)
        if f2b_changed or not _unit_active(cfg, "fail2ban"):
            run(cfg, "systemctl", "restart", "fail2ban", check=False)
        info(cfg, "  → fail2ban enabled (jail: oink-auth)")

    if cfg.dry_run:
        info(cfg, f"  → Would add {cfg.obs_user} to systemd-journal group")
    else:
        groups = run(cfg, "id", "-nG", cfg.obs_user, capture=True, check=False)
        if "systemd-journal" not in (groups.stdout or "").split():
            run(cfg, "usermod", "-aG", "systemd-journal", cfg.obs_user)
            info(cfg, f"  → Added {cfg.obs_user} to systemd-journal (journalctl access)")
            force_restart.add("oink-api")

    # ── Units (render + write only on change) ────────────────────────────────
    units = [
        {"name": "oink-nginx", "template": "oink-nginx.service"},
        {"name": "oink-mediamtx", "template": "oink-mediamtx.service"},
        {"name": "oink-noalbs", "template": "oink-noalbs.service"},
        {"name": "oink-api", "template": "oink-api.service"},
    ]

    written = {}
    daemon_reload = False
    for spec in units:
        content = _render_unit(cfg, spec["template"])
        if _unit_path(spec["name"]).exists() and \
                _unit_path(spec["name"]).read_text() == content:
            continue
        written[spec["name"]] = True
        if cfg.dry_run:
            info(cfg, f"  → Would write /etc/systemd/system/{spec['name']}.service")
        else:
            _unit_path(spec["name"]).write_text(content)
        daemon_reload = True

    if daemon_reload:
        run(cfg, "systemctl", "daemon-reload")

    # ── Enable + converge ────────────────────────────────────────────────────
    # oink-noalbs = "stream drop protection": installed but OFF by default. It is
    # never enabled, so it does not auto-start on boot; the dashboard toggle
    # (start/stop via the polkit rule) turns it on per session. The stack phase
    # converges it back to disabled+stopped so re-runs reset to the default.
    DORMANT_UNITS = {"oink-noalbs"}

    for spec in units:
        name = spec["name"]
        if name in DORMANT_UNITS:
            run(cfg, "systemctl", "disable", name, check=False)
            if _unit_active(cfg, name):
                info(cfg, f"  → Stopping {name} (off by default; dashboard toggle enables)")
                run(cfg, "systemctl", "stop", name, check=False)
            else:
                info(cfg, f"  → {name} installed but off (dashboard toggle enables)")
            continue
        run(cfg, "systemctl", "enable", name, check=False)
        if _unit_active(cfg, name):
            if written.get(name) or name in force_restart:
                info(cfg, f"  → Restarting {name} (unit changed)…")
                run(cfg, "systemctl", "restart", name, check=False)
            else:
                info(cfg, f"  → {name} already current (active)")
        else:
            info(cfg, f"  → Starting {name}…")
            run(cfg, "systemctl", "start", name, check=False)

def _detect_nvenc(cfg: SetupConfig) -> bool:
    """True when an NVIDIA GPU/driver is present, i.e. NVENC is available.

    NVENC only exists on NVIDIA hardware; this box (Virtio GPU) and other
    non-NVIDIA hosts return False so the dashboard can hide the NVENC option.
    """
    if pathlib.Path("/dev/nvidia0").exists():
        return True
    return run_ok(cfg, "nvidia-smi", "-L")


def _api_env_value(cfg: SetupConfig, key: str) -> str | None:
    """Read a KEY=VALUE pair from the provisioned api.env (or None)."""
    env_file = cfg.stack_dir / "api.env"
    if not env_file.exists():
        return None
    for ln in env_file.read_text().splitlines():
        if "=" in ln:
            k, v = ln.split("=", 1)
            if k.strip() == key:
                return v.strip()
    return None


def _dashboard_password_line(cfg: SetupConfig) -> str | None:
    """Return the summary-box line for the bootstrap seed, or None to omit.

    Only auto-generated seeds are shown: that is the one-time credential the
    operator could not have known. Operator-provided seeds are the operator's
    own secret and are not re-printed into setup output.
    """
    pw = _api_env_value(cfg, "OINK_ADMIN_PASSWORD")
    origin = _api_env_value(cfg, "OINK_ADMIN_PASSWORD_ORIGIN")
    if not pw or origin != "generated":
        return None
    return f"  Dashboard pw:  {pw}  (one-time — change it at first login)"


def section6_verify(cfg: SetupConfig) -> None:
    """§6  Verify the native stack."""
    info(cfg, "§6  Verifying native stack…")

    deadline = time.time() + 60
    results: list[tuple[str, bool]] = []

    def check(desc: str, cmd: str) -> None:
        results.append((desc, wait_check(cfg, desc, cmd, deadline)))

    check("oink-nginx active", "systemctl is-active oink-nginx")
    web_port = resolve_web_port(cfg)
    check(f"Dashboard on :{web_port}", f"ss -ltn | grep -q ':{web_port} '")

    check("oink-mediamtx active", "systemctl is-active oink-mediamtx")
    check("RTMP ingest on :1935", "ss -ltn | grep -q ':1935'")
    check("SRT ingest on :8890", "ss -uln | grep -q ':8890'")

    check("oink-noalbs installed (off by default)",
          "[ -f /etc/systemd/system/oink-noalbs.service ] && systemctl is-enabled oink-noalbs | grep -q disabled")

    check("oink-api active", "systemctl is-active oink-api")
    check("API on :8082", "ss -ltn | grep -q ':8082'")

    check("fail2ban active", "systemctl is-active fail2ban")
    check("fail2ban jail oink-auth", "fail2ban-client status oink-auth")

    # Verify the recording pin stuck: at least one OBS profile must declare
    # RecFilePath pointing at the monitored recordings dir.
    def recfile_ok() -> None:
        glob = str(cfg.obs_cfg / "basic/profiles/*/basic.ini")
        cmd = f"grep -l '^RecFilePath={cfg.recording_dir}$' {glob} >/dev/null 2>&1"
        t0 = time.time()
        while True:
            if run_ok(cfg, cmd, shell=True):
                print(f"  {C['green']}\u2713{C['nc']} OBS records to {cfg.recording_dir}")
                results.append(("recordings path pinned", True))
                return
            if time.time() - t0 >= 15:
                print(f"  {C['red']}\u2717{C['nc']} RecFilePath not pinned to {cfg.recording_dir}")
                results.append(("recordings path pinned", False))
                return
            time.sleep(3)
    recfile_ok()

    passed = all(ok for _, ok in results)

    print()
    if passed:
        try:
            ip = subprocess.check_output(["hostname", "-I"], text=True).strip().split()[0]
        except Exception:
            ip = "???"
        info(cfg, "════════════════════════════════════════════════════════════")
        info(cfg, "  All checks passed \u2713")
        web_port = resolve_web_port(cfg)
        info(cfg, f"  Dashboard:     http://{ip}:{web_port}")
        dash_pw = _dashboard_password_line(cfg)
        if dash_pw:
            info(cfg, dash_pw)
        info(cfg, f"  Remote OBS:    http://{ip}:{web_port}/remote/ (sign in to the dashboard first)")
        info(cfg, f"  RTMP Ingest:   rtmp://{ip}:1935/live/{{stream_key}}/{{label}}")
        info(cfg, f"  SRT Ingest:    srt://{ip}:8890?streamid=publish:live/{{stream_key}}/{{label}}")
        info(cfg, "════════════════════════════════════════════════════════════")
    else:
        warn(cfg, "════════════════════════════════════════════════════════════")
        warn(cfg, "  Some checks failed \u2014 review output above")
        warn(cfg, "  Logs: journalctl -u oink-nginx -n 50 -e (etc.)")
        warn(cfg, "════════════════════════════════════════════════════════════")
        raise SystemExit(1)

# ── Entry (native-stack phase of `oink setup`) ────────────────────────────────

def stack_main(cfg: SetupConfig) -> int:
    if os.geteuid() != 0:
        bail(cfg, "Run as root (sudo).")

    # Fail fast on a bad OINK_TRUSTED_PROXIES: it is rendered verbatim into
    # nginx.conf (set_real_ip_from), so a typo must not reach the config file.
    problem = check_trusted_proxies(_trusted_proxies_raw())
    if problem:
        bail(cfg, f"OINK_TRUSTED_PROXIES invalid — {problem}. "
                  "Use true, false, or a comma-separated CIDR list.")

    info(cfg, "════════════════════════════════════════════════════════════")
    info(cfg, "  OpenIRLNodeKit — Native Stack")
    info(cfg, "════════════════════════════════════════════════════════════")
    print()

    def _step(name: str, fn, *fn_args) -> None:
        t0 = time.time()
        fn(*fn_args)
        print(f"  → {name} done in {int(time.time() - t0)}s")

    # ── Run sections ──────────────────────────────────────────────────────────
    _step("§1 prerequisites", section1_prereqs, cfg)
    _step("§2 dashboard build", section2_build_dashboard, cfg)
    _step("§3 web install", section3_install_web, cfg)
    _step("§4 MediaMTX", section4_install_ingest, cfg)
    _step("§4b NOALBS", section4b_install_noalbs, cfg)
    _step("§5 stack install", section5_install_stack, cfg)

    # ── Verification ──────────────────────────────────────────────────────────
    if cfg.dry_run:
        print()
        info(cfg, "════════════════════════════════════════════════════════════")
        info(cfg, "  Verification skipped (dry-run)")
        info(cfg, "════════════════════════════════════════════════════════════")
    else:
        _step("§6 stack verify", section6_verify, cfg)

    return 0
