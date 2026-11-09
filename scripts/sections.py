# SPDX-FileCopyrightText: 2026 OpenIRLNodeKit contributors
# SPDX-License-Identifier: AGPL-3.0-or-later
"""Host-setup phases (sections 1-8)."""

from __future__ import annotations

import configparser
import hashlib
import io
import json
import os
import pathlib
import re
import secrets
import shutil

from constants import (
    AITUM_MIN_OBS,
    AITUM_PLUGINS,
    BACKUP_PKGS,
    BASE_DIR,
    BASE_PKGS,
    COMMON_PKGS,
    DUMMY_DISPLAY,
    GUAC_PKGS,
    IRL_SOURCE,
    NGINX_PKGS,
    OBS_PKGS,
    OBS_WS_PORT,
    OBS_WS_TIMEOUT,
    OINK_CLI,
    OINK_GROUP,
    OINK_LIBEXEC,
    REBOOT_MARKER,
    SECURITY_PKGS,
    SRTLA_BUILD_PKGS,
    TAR_PKGS,
    X11_PKGS,
)
from logui import C, bail, confirm, info, warn
from models import HostState, Phase, Result, SetupConfig

# The OBS profile/canvas logic (§6c) lives in obs_profile.py so sections.py does
# not swell past an atomically reviewable size. It also owns the shared OBS
# version/plugin check helpers, which the plugin-install sections below reuse.
from obs_profile import (
    PLUGIN_VERSION_MARKER,
    _obs_semver_at_least,
    _obs_semver_tuple,
    _obs_version_str,
    plugin_matches,
)
from process import apt_get, node_semver, run, run_ok, wait_port


def _nvidia_display_devices() -> list[pathlib.Path]:
    """PCI devices that are NVIDIA display controllers."""
    found = []
    for dev in pathlib.Path("/sys/bus/pci/devices").glob("*"):
        try:
            if (dev / "vendor").read_text().strip() != "0x10de":
                continue
            if not (dev / "class").read_text().strip().startswith("0x03"):
                continue
        except OSError:
            continue
        found.append(dev)
    return found


def _nvidia_driver_installed(cfg: SetupConfig) -> bool:
    """True when the proprietary NVIDIA driver is loaded (headless GPU usable)."""
    if pathlib.Path("/dev/nvidia0").exists():
        return True
    # dry-run must not treat a printed command as a successful probe
    return not cfg.dry_run and run_ok(cfg, "nvidia-smi", "-L")


def _nvidia_utils_version(cfg: SetupConfig) -> str | None:
    """Installed nvidia-utils major version, e.g. "580" (LIB version match)."""
    r = run(cfg, "dpkg-query", "-W", "-f=${Package}\n", "nvidia-utils-*",
            check=False, capture=True)
    versions = re.findall(r"^nvidia-utils-(\d+)$", r.stdout or "", re.MULTILINE)
    return max(versions, key=int) if versions else None


def _nvidia_pci_bus_id() -> str | None:
    """Xorg BusID for the first NVIDIA display controller, e.g. PCI:6:0:0."""
    for dev in _nvidia_display_devices():
        try:
            _, bus, slot_func = dev.name.split(":")
            slot, func = slot_func.split(".")
        except ValueError:
            continue
        return f"PCI:{int(bus, 16)}:{int(slot, 16)}:{int(func, 16)}"
    return None


def section_base_packages(cfg: SetupConfig, state: HostState) -> Result:
    """§1  Repos + one apt pass: X11/VNC/FFmpeg, guacd, Nginx, OBS (PPA), Node 22, v4l2loopback."""
    info(cfg, f"{Phase.BASE_PACKAGES.section_marker}  Installing base packages…")

    # OBS comes from the OBS PPA and Node 22 from NodeSource, so both repos are
    # added here (before the apt pass) rather than installing later.
    obs_installed = run_ok(cfg, "dpkg", "-s", "obs-studio")
    node_ok = _node_22_ok(cfg)
    key_pkgs = (list(BASE_PKGS) + list(GUAC_PKGS) + list(NGINX_PKGS) + list(OBS_PKGS)
                + list(TAR_PKGS) + list(SECURITY_PKGS) + list(BACKUP_PKGS)
                + list(SRTLA_BUILD_PKGS))
    all_installed = all(run_ok(cfg, "dpkg", "-s", p) for p in key_pkgs) and node_ok
    if all_installed:
        info(cfg, "  → Base packages already installed, skipping apt-get")
        _load_v4l2loopback(cfg)
        _disable_unattended_upgrades(cfg)
        return Result(True)

    if not confirm(cfg, "Install OBS Studio (PPA) + Node 22 (NodeSource) + X11/VNC/FFmpeg + guacd + Nginx (apt)?"):
        info(cfg, "  → Skipping apt-get install")
        return Result(True, "base packages skipped by user")

    # Refresh the package lists once up front so the PPA/repo adds below never
    # run against empty/stale lists (fresh hosts).
    apt_get(cfg, "update")

    # add-apt-repository for the OBS PPA (software-properties-common ships on
    # Ubuntu Server, so no separate install step is needed).
    if not obs_installed:
        info(cfg, "  → Adding OBS PPA (ppa:obsproject/obs-studio)…")
        run(cfg, "add-apt-repository", "-y", "ppa:obsproject/obs-studio",
             capture=not cfg.verbose)
    if not node_ok:
        info(cfg, "  → Adding NodeSource repo (Node 22)…")
        run(cfg, "bash", "-c",
            "set -o pipefail; curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -",
            capture=not cfg.verbose)

    install_list = [*X11_PKGS, *COMMON_PKGS, *GUAC_PKGS, *OBS_PKGS, *TAR_PKGS, *NGINX_PKGS, *SECURITY_PKGS]
    if not node_ok:
        install_list.append("nodejs")
    apt_get(cfg, "install", "-y", "--no-install-recommends", *install_list)

    if not run_ok(cfg, "dpkg", "-s", "obs-studio"):
        bail(cfg, "obs-studio installation failed — check apt output above")
    if not _node_22_ok(cfg):
        if cfg.dry_run:
            info(cfg, "  [dry-run] Node.js/npm presence is checked on a real run")
        else:
            bail(cfg, "Node.js >= 22.12 with npm is required but is not available.\n"
                 "The NodeSource repo may have failed to add — install it manually:\n"
                 "  curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash - "
                 "&& sudo apt-get install -y nodejs")

    _load_v4l2loopback(cfg)
    _disable_unattended_upgrades(cfg)
    return Result(True)


_V4L2_MODULE_CONF = pathlib.Path("/etc/modules-load.d/oink-v4l2loopback.conf")
_V4L2_MODPROBE_CONF = pathlib.Path("/etc/modprobe.d/oink-v4l2loopback.conf")
_V4L2_MODPROBE_OPTS = 'options v4l2loopback exclusive_caps=1 card_label="OBS Virtual Camera"\n'

# Unattended-upgrades: automatic kernel upgrades silently break the OBS virtual
# camera (new kernel ships without the linux-modules-extra v4l2loopback needs;
# setup only installs extras for the kernel it runs under). The 20auto-upgrades
# file is the distro's on/off switch; writing 0 disables both list refreshes and
# the upgrade run. Unattended-upgrades is not a setup-managed package, so the
# helper no-ops on hosts where it is absent.
_APT_CONF_DIR = pathlib.Path("/etc/apt/apt.conf.d")
_AUTO_UPGRADES_CONF = _APT_CONF_DIR / "20auto-upgrades"


def _confirm_dedicated_box(cfg: SetupConfig) -> None:
    """Hard consent gate: this box must be dedicated to OINK.

    Prints a random 6-character code the operator must type back. Unlike
    ordinary prompts, --yes does NOT skip this — the box being OINK-only is a
    hard install requirement (setup disables unattended-upgrades and OINK's
    config assumes nothing else runs here). Only --force bypasses it. A wrong
    code, EOF or Ctrl-C aborts setup.
    """
    if cfg.dry_run:
        info(cfg, "  [dry-run] would prompt: confirm this box is dedicated to OINK")
        return
    rule = f"  {C['yellow']}{'─' * 66}{C['nc']}"
    print()
    print(rule)
    print(f"  {C['yellow']}{C['bold']}DEDICATED BOX REQUIRED{C['nc']}")
    print("  Nothing else should be installed or running on this host.")
    print("  OINK disables unattended-upgrades and assumes exclusive access;")
    print("  other workloads can break it, and it can break other workloads.")
    if _nvidia_display_devices():
        print("  NVIDIA GPU detected: setup installs the proprietary NVIDIA driver")
        print("  so OBS renders and encodes on it.")
    print(rule)
    if cfg.force:
        print(f"  {C['green']}\u2713{C['nc']} dedicated-box check skipped (--force)")
        print()
        return
    code = secrets.token_hex(3).upper()
    print(f"  {C['bold']}Confirmation code:{C['nc']}")
    print()
    print(f"    {C['cyan']}{C['bold']}┌──────────┐{C['nc']}")
    print(f"    {C['cyan']}{C['bold']}│  {C['nc']}{C['bold']}{code}{C['cyan']}{C['bold']}  │{C['nc']}")
    print(f"    {C['cyan']}{C['bold']}└──────────┘{C['nc']}")
    print()
    try:
        answer = input(f"  Type {C['cyan']}{C['bold']}the code above{C['nc']} (case-insensitive) \u2192 ")
    except (EOFError, KeyboardInterrupt):
        bail(cfg, "Setup aborted — no confirmation code entered.")
    if not secrets.compare_digest(answer.strip().upper(), code):
        print()
        bail(cfg, "Setup aborted — wrong confirmation code.")
    print(f"  {C['green']}\u2713{C['nc']} box confirmed OINK-only")
    print()


def _disable_unattended_upgrades(cfg: SetupConfig) -> None:
    """Turn off unattended-upgrades — a hard requirement, no user choice.

    Automatic Ubuntu package upgrades can silently break OINK: kernel bumps
    kill the OBS virtual camera (the new kernel ships without the
    linux-modules-extra v4l2loopback needs), and updates to ffmpeg/nginx/
    guacd/fail2ban/xorg can degrade preview, the dashboard proxy, remote
    desktop or the brute-force login guard. PPA-pinned OBS and Node.js are
    never auto-updated anyway ('oink upgrade' handles them). The
    20auto-upgrades file is the distro's on/off switch; writing 0 disables
    both list refreshes and the upgrade run. No-op on hosts without the
    package or already off; manual upgrades still work.
    """
    if cfg.dry_run:
        info(cfg, "  [dry-run] would disable unattended-upgrades (write 20auto-upgrades 0/0)")
        return
    if not run_ok(cfg, "dpkg", "-s", "unattended-upgrades"):
        info(cfg, "  → unattended-upgrades not installed — nothing to disable")
        return
    enabled = any(
        re.search(r'APT::Periodic::Unattended-Upgrade\s+"1"', f.read_text(errors="ignore"))
        for f in _APT_CONF_DIR.glob("*") if f.is_file()
    )
    if not enabled:
        info(cfg, "  → unattended-upgrades already disabled")
        return
    _AUTO_UPGRADES_CONF.write_text(
        'APT::Periodic::Update-Package-Lists "0";\n'
        'APT::Periodic::Unattended-Upgrade "0";\n',
    )
    info(cfg, "  → disabled unattended-upgrades (20auto-upgrades) — "
              "upgrade manually with 'sudo apt-get update && sudo apt-get upgrade'")


def _ensure_kernel_modules_extra(cfg: SetupConfig) -> None:
    """Install linux-modules-extra-<kernel> so v4l2loopback can be modprobed.

    Generic/HWE kernels ship v4l2loopback in -modules-extra. Custom/cloud
    kernels often have no such package, so failure is a warning, not fatal.
    """
    pkg = f"linux-modules-extra-{os.uname().release}"
    if run_ok(cfg, "dpkg", "-s", pkg):
        return
    info(cfg, f"  → installing {pkg} (provides v4l2loopback)…")
    if not run_ok(cfg, "apt-get", "install", "-y", pkg):
        warn(cfg, f"  → {pkg} unavailable — virtual camera may need manual install")


def _load_v4l2loopback(cfg: SetupConfig) -> None:
    """Load v4l2loopback now and on every boot so OBS registers its virtual camera.

    OBS only registers "OBS Virtual Camera" when the module is already present.
    The modprobe is idempotent, so this runs on every §1 pass.
    """
    if cfg.dry_run:
        info(cfg, "  [dry-run] would load v4l2loopback + persist modprobe config")
        return
    _ensure_kernel_modules_extra(cfg)
    for path, text in (
        (_V4L2_MODULE_CONF, "v4l2loopback\n"),
        (_V4L2_MODPROBE_CONF, _V4L2_MODPROBE_OPTS),
    ):
        if not path.exists() or path.read_text() != text:
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(text)
            info(cfg, f"  → wrote {path}")
    run(cfg, "modprobe", "v4l2loopback", check=False)
    if pathlib.Path("/sys/module/v4l2loopback").exists():
        info(cfg, "  → v4l2loopback loaded (OBS virtual camera available)")
    else:
        warn(cfg, "  → v4l2loopback not loadable (DKMS build needs matching kernel headers?)")


def section_nvidia_driver(cfg: SetupConfig, state: HostState) -> Result:
    """§1c  Install the proprietary NVIDIA driver on NVIDIA hosts.

    Ubuntu's supported path is `ubuntu-drivers`, which picks the recommended
    driver for the release. This runs before §2, so no X server has the GPU yet:
    the module can usually be loaded in place (freeing nouveau) and setup
    continues in the same run. Only when that fails is a reboot marker written
    and the next `oink setup` run continues from §1b.
    """
    info(cfg, f"{Phase.NVIDIA_DRIVER.section_marker}  Configuring NVIDIA driver…")
    if not _nvidia_display_devices():
        info(cfg, "  → no NVIDIA GPU detected, skipping")
        return Result(True, "no NVIDIA GPU")

    dummy_conf = pathlib.Path("/etc/X11/xorg.conf.d/10-oink-dummy.conf")
    if _nvidia_driver_installed(cfg):
        info(cfg, "  → proprietary NVIDIA driver already loaded")
        # A box that ran the old software path has a "done" dummy phase; drop it
        # so §2 rewrites the display config for the GPU on this run.
        if dummy_conf.exists():
            state.completed_phases.discard(Phase.DUMMY_DISPLAY)
        return Result(True, "NVIDIA driver already installed")

    info(cfg, "  → NVIDIA GPU detected; OBS will render and encode on it")
    if not confirm(
        cfg, "Install the proprietary NVIDIA driver (ubuntu-drivers) and the NVENC runtime?"
    ):
        info(cfg, "  → skipped; OBS will keep using software rendering")
        return Result(True, "NVIDIA driver install skipped by user")

    if not run_ok(cfg, "command", "-v", "ubuntu-drivers"):
        apt_get(cfg, "install", "-y", "ubuntu-drivers-common")
    apt_get(cfg, "update")
    run(cfg, "ubuntu-drivers", "install", "--gpgpu")

    # NVENC runtime is a separate package from the driver.
    version = _nvidia_utils_version(cfg)
    if version:
        apt_get(cfg, "install", "-y", f"libnvidia-encode-{version}")
    elif not cfg.dry_run:
        warn(cfg, "  → could not detect the installed driver version; install "
                  "libnvidia-encode-<version> manually for NVENC")

    sb = run(cfg, "mokutil", "--sb-state", check=False, capture=True)
    if "SecureBoot enabled" in (sb.stdout or ""):
        warn(cfg, "  → Secure Boot is enabled: the NVIDIA DKMS module must be "
                  "enrolled (MOK) or the GPU will not load after reboot")

    # OINK boxes are headless, so nouveau can be unloaded and the new module
    # loaded now instead of after a reboot. X starts later (§2), so nothing
    # holds the GPU. Failure just falls through to the reboot path.
    run(cfg, "modprobe", "-r", "nouveau", check=False)
    run(cfg, "modprobe", "nvidia", check=False)
    if _nvidia_driver_installed(cfg):
        info(cfg, "  → driver loaded; no reboot needed")
        return Result(True, "NVIDIA driver installed and loaded")

    if not cfg.dry_run:
        REBOOT_MARKER.parent.mkdir(parents=True, exist_ok=True)
        REBOOT_MARKER.write_text("nvidia driver installed\n")
    info(cfg, "  → driver installed; reboot required before the GPU is usable")
    return Result(True, "NVIDIA driver installed")


def section_obs_user(cfg: SetupConfig, state: HostState) -> Result:
    """§1b  Create the unprivileged `obsuser` runtime account + shared group.

    OBS, Guacamole, and the deployed stack run as this user (never the admin
    `sudo` user). The account gets a nologin shell and owns only its own home
    tree; `dependencies` and `recordings` are group-writable (setgid) so both
    the runtime user and the admin can manage them, and nothing else is granted.
    """
    info(cfg, f"{Phase.OBS_USER.section_marker}  Creating runtime user {cfg.obs_user}…")

    if not run_ok(cfg, "getent", "passwd", cfg.obs_user):
        run(cfg, "useradd", "--system", "--create-home",
            "--home-dir", str(cfg.obs_home),
            "--shell", "/usr/sbin/nologin", cfg.obs_user)
        info(cfg, f"  → created system user {cfg.obs_user} ({cfg.obs_home})")
    else:
        info(cfg, f"  → {cfg.obs_user} already exists")

    if not run_ok(cfg, "getent", "group", OINK_GROUP):
        run(cfg, "groupadd", OINK_GROUP)
        info(cfg, f"  → created group {OINK_GROUP}")
    else:
        info(cfg, f"  → group {OINK_GROUP} already exists")

    run(cfg, "usermod", "-aG", OINK_GROUP, cfg.obs_user)
    run(cfg, "usermod", "-aG", OINK_GROUP, cfg.user)
    # /dev/video* is group `video`; OBS needs it to publish the virtual camera.
    run(cfg, "usermod", "-aG", "video", cfg.obs_user)
    # /dev/dri/renderD* is group `render`; needed for GPU render/VAAPI paths.
    if run_ok(cfg, "getent", "group", "render"):
        run(cfg, "usermod", "-aG", "render", cfg.obs_user)
    info(cfg, f"  → added {cfg.obs_user} and {cfg.user} to {OINK_GROUP}, {cfg.obs_user} to video/render")

    # Shared runtime dirs: group-writable + setgid so files created by either
    # the runtime user or the admin inherit the group.
    for d in (cfg.dep_dir, cfg.recording_dir):
        run(cfg, "install", "-d", "-m", "0770", "-o", cfg.obs_user, "-g", OINK_GROUP, str(d))
        run(cfg, "chmod", "g+s", str(d))
    info(cfg, f"  → {cfg.dep_dir} and {cfg.recording_dir} (0770, setgid {OINK_GROUP})")

    # Lock the home down: owner-only traversal.
    run(cfg, "chown", f"{cfg.obs_user}:{cfg.obs_user}", str(cfg.obs_home))
    run(cfg, "chmod", "0750", str(cfg.obs_home))

    return Result(True, "runtime user created")


def section_dummy_display(cfg: SetupConfig, state: HostState) -> Result:
    """§2  Configure the :99 display, on the NVIDIA GPU when its driver is loaded."""
    info(cfg, f"{Phase.DUMMY_DISPLAY.section_marker}  Configuring display at {DUMMY_DISPLAY}…")
    xorg_dir = pathlib.Path("/etc/X11/xorg.conf.d")
    dummy_conf = xorg_dir / "10-oink-dummy.conf"
    nvidia_conf = xorg_dir / "10-oink-nvidia.conf"

    if _nvidia_driver_installed(cfg):
        text = cfg.template("10-oink-nvidia.conf").replace(
            "$NVIDIA_BUSID", _nvidia_pci_bus_id() or "PCI:6:0:0")
        target, stale = nvidia_conf, dummy_conf
        info(cfg, "  → NVIDIA driver detected; using headless GPU display")
    else:
        text = cfg.template("10-oink-dummy.conf")
        target, stale = dummy_conf, nvidia_conf

    if not cfg.dry_run:
        target.parent.mkdir(parents=True, exist_ok=True)
        if not target.exists() or target.read_text() != text:
            target.write_text(text)
            info(cfg, f"  → wrote {target}")
        else:
            info(cfg, f"  → {target} already current")
        # Only one of the two configs may exist: dropping the stale one lets a
        # later `oink setup` switch the box back to software GL cleanly.
        stale.unlink(missing_ok=True)
    return Result(True)


def section_oink_display(cfg: SetupConfig, state: HostState) -> Result:
    """§3  Install oink-display.service (Xorg :99)."""
    info(cfg, f"{Phase.OINK_DISPLAY.section_marker}  Installing oink-display.service…")
    if not cfg.dry_run:
        pathlib.Path("/etc/systemd/system/oink-display.service").write_text(cfg.template("oink-display.service"))
    run(cfg, "systemctl", "daemon-reload")
    run(cfg, "systemctl", "enable", "--now", "oink-display")
    return Result(True)


def section_obs_install(cfg: SetupConfig, state: HostState) -> Result:
    """§4  Scaffold the native OBS config (obs-studio was installed in §1)."""
    info(cfg, f"{Phase.OBS_INSTALL.section_marker}  Configuring OBS Studio…")

    if not run_ok(cfg, "dpkg", "-s", "obs-studio"):
        bail(cfg, "obs-studio is not installed — the §1 apt pass should have installed it.")

    # One `obs --version` subprocess feeds the whole phase: the banner line, the
    # global.ini LastVersion, and the state's obs_version all derive from it.
    r = run(cfg, "obs", "--version", capture=True, check=False)
    stdout = (r.stdout if r else "") or ""
    semver = _semver_from_stdout(stdout)
    for line in stdout.splitlines():
        if line.strip():
            info(cfg, f"  → {line.strip()}")
            break

    # Scaffold OBS config dirs (the oink profile dir must exist before the
    # first oink-obs start so the golden user.ini ExecStartPre can install into it)
    info(cfg, "  → scaffolding OBS config dirs…")
    for d in [cfg.obs_cfg / "basic/scenes", cfg.user_ini.parent, cfg.obs_ws]:
        run(cfg, "mkdir", "-p", str(d))

    _configure_global_ini(cfg, semver)

    # Hand the whole config tree to obsuser (OBS owns and rewrites these files).
    run(cfg, "chown", "-R", f"{cfg.obs_user}:{cfg.obs_user}", str(cfg.obs_home / ".config"))

    state.obs_version = semver
    return Result(True, "OBS Studio configured")


def _configure_global_ini(cfg: SetupConfig, semver: str) -> None:
    """Edit global.ini — set BrowserHWAccel=false (headless = no GPU) and LastVersion to suppress auto-config wizard."""
    ini = cfg.global_ini
    if not ini.exists():
        if not cfg.dry_run:
            ini.parent.mkdir(parents=True, exist_ok=True)
            ini.write_text(
                f"[General]\nBrowserHWAccel=false\nLastVersion={semver}\n"
            )
        info(cfg, "  → wrote global.ini (BrowserHWAccel=false, LastVersion set)")
        return

    if cfg.dry_run:
        info(cfg, "  → checked global.ini")
        return

    parser = configparser.ConfigParser(interpolation=None)
    parser.optionxform = str
    try:
        parser.read(ini)
    except configparser.Error:
        bail(cfg, f"Could not parse {ini}; leaving it untouched")
    if not parser.has_section("General"):
        parser.add_section("General")
    parser.set("General", "BrowserHWAccel", "false")
    parser.set("General", "LastVersion", semver)
    out = io.StringIO()
    parser.write(out)
    result = out.getvalue()
    if result != ini.read_text():
        ini.write_text(result)
        info(cfg, "  → wrote global.ini (BrowserHWAccel=false, LastVersion set)")
    else:
        info(cfg, "  → global.ini already correct")


def _semver_from_stdout(stdout: str) -> str:
    """Encode the OBS version from `obs --version` output as a semantic version
    integer string (major*1000000 + minor*1000 + patch), or "0" if unparsable."""
    v = _obs_semver_tuple(stdout)
    if not v:
        return "0"
    return str(v[0] * 1000000 + v[1] * 1000 + v[2])


def section_obs_golden(cfg: SetupConfig, state: HostState) -> Result:
    """§4b  Install golden user.ini (converge-on-every-start model)."""
    info(cfg, f"{Phase.OBS_GOLDEN.section_marker} Installing golden user.ini…")
    golden = cfg.obs_home / "user.ini.golden"
    if not cfg.dry_run:
        golden.write_text(cfg.template("user.ini.golden"))
    info(cfg, f"  → wrote {golden}")
    return Result(True)


def section_obs_irl_source(cfg: SetupConfig, state: HostState) -> Result:
    """§4c  Install the obs-irl-source plugin (default in the build).

    Drops the obs-irl-source linux-x64 release into
    ~/.config/obs-studio/plugins/obs-irl-source (the config plugin dir OBS
    scans for per-user plugins; the native OBS binary loads these the same way
    it loads its system plugin dir). This plugin IS the ingest read source:
    the dashboard provisions every feed as an `irl_source` input, so setup
    fails outright if it cannot be installed.

    v2.0.0 resolves libobs symbols from the OBS process at load time and is
    built against glibc 2.35, so the prebuilt tarball loads on Ubuntu 24.04
    (and the OBS Flatpak). It requires OBS >= 32.1. The plugin metadata
    (pinned release URL + sha256, min OBS) comes from stack/components.json.
    """
    info(cfg, f"{Phase.OBS_IRL_SOURCE.section_marker}  Installing obs-irl-source plugin (default)…")

    plugins_root = cfg.obs_cfg / "plugins"
    marker = plugins_root / "obs-irl-source"

    if plugin_matches(marker, IRL_SOURCE["version"]):
        info(cfg, f"  → obs-irl-source v{IRL_SOURCE['version']} already present at {marker}")
        _restart_obs_for_plugin(cfg)
        return Result(True, "obs-irl-source plugin already installed")

    # OBS >= 32.1 gate — the plugin's api_version floor. The plugin is the only
    # ingest read source, so an incompatible OBS is a hard failure, not a skip.
    min_obs = tuple(IRL_SOURCE["min_obs"])
    if not _obs_semver_at_least(cfg, min_obs):
        bail(cfg, f"OBS {_obs_version_str(cfg) or '?'} is older than the "
                  f"{'.'.join(map(str, min_obs))}+ obs-irl-source requires — "
                  "upgrade OBS (ppa:obsproject/obs-studio) and re-run setup")

    if cfg.dry_run:
        return Result(True, "obs-irl-source plugin would be installed")

    tmp = pathlib.Path("/tmp") / f"oink-irl-source-{IRL_SOURCE['version']}"
    staging = pathlib.Path("/tmp") / f"oink-irl-source-extract-{IRL_SOURCE['version']}"
    try:
        run(cfg, "mkdir", "-p", str(plugins_root))
        run(cfg, "curl", "-fsSL", "-o", str(tmp), IRL_SOURCE["url"])

        digest = hashlib.sha256(tmp.read_bytes()).hexdigest()
        if digest != IRL_SOURCE["sha256"]:
            raise RuntimeError(f"obs-irl-source checksum mismatch (got {digest[:12]}…)")

        run(cfg, "rm", "-rf", str(staging))
        run(cfg, "mkdir", "-p", str(staging))
        run(cfg, "tar", "xzf", str(tmp), "-C", str(staging))

        # The tarball stages an obs-irl-source-<ver>-linux-x64 root containing a
        # bin/64bit/*.so + data/ tree. Copy that whole staged tree into the
        # plugins dir (robust to minor layout drift: we require the .so below).
        extract_root = staging / f"obs-irl-source-{IRL_SOURCE['version']}-linux-x64"
        if not extract_root.exists():
            extract_root = next(staging.iterdir()) if any(staging.iterdir()) else None
        if extract_root is None:
            raise RuntimeError("tarball contained no plugin root")
        if not any(extract_root.rglob("*.so")):
            raise RuntimeError("tarball contained no plugin .so")

        dest = plugins_root / "obs-irl-source"
        # Replace any existing copy wholesale on a version change (no stale .so).
        run(cfg, "rm", "-rf", str(dest))
        run(cfg, "cp", "-a", str(extract_root), str(dest))
        (dest / PLUGIN_VERSION_MARKER).write_text(IRL_SOURCE["version"] + "\n")
        run(cfg, "chown", "-R", f"{cfg.obs_user}:{cfg.obs_user}", str(dest))
        run(cfg, "rm", "-rf", str(staging))
        run(cfg, "rm", "-f", str(tmp))
        info(cfg, "  → installed obs-irl-source plugin")
    except Exception as e:
        tmp.unlink(missing_ok=True) if tmp.exists() else None
        shutil.rmtree(staging, ignore_errors=True) if staging.exists() else None
        bail(cfg, f"obs-irl-source install failed ({e}) — aborting setup")

    # Load the plugin: on a fresh setup OBS hasn't started yet (§6 launches it),
    # so nothing to do. On an idempotent re-run OBS is already up — restart only
    # if the unit is active so the new plugin gets loaded.
    _restart_obs_for_plugin(cfg)
    return Result(True, f"obs-irl-source v{IRL_SOURCE['version']} installed")


def section_aitum_plugins(cfg: SetupConfig, state: HostState) -> Result:
    """§4d  Install the Aitum Multistream + Vertical Canvas plugins (default).

    Both plugins ship as GitHub-release .debs. Setup extracts them with
    ``dpkg-deb -x`` (no apt — avoids Qt6 dependency resolution; the runtime
    libs come with the desktop OBS from the PPA) and remaps the package layout
    (usr/lib/<triplet>/obs-plugins/<name>.so + usr/share/obs/obs-plugins/<name>)
    onto OBS's per-user plugin dir: ~/.config/obs-studio/plugins/<name>/{bin/64bit,data}.

    The Aitum pair requires OBS >= 30 (guarded below). Metadata (pinned release
    URL + sha256, min OBS) comes from stack/components.json. As defaults of
    the build, a failed download/checksum/extract ABORTS the setup (bail) rather
    than degrading the node.
    """
    info(cfg, f"{Phase.AITUM_PLUGINS.section_marker}  Installing Aitum OBS plugins (default)…")

    plugins_root = cfg.obs_cfg / "plugins"
    missing = [p for p in AITUM_PLUGINS
               if not plugin_matches(plugins_root / p["name"], p["version"])]

    if not missing:
        info(cfg, "  → Aitum plugins already present")
        _restart_obs_for_plugin(cfg)
        return Result(True, "aitum plugins already installed")

    if not _obs_semver_at_least(cfg, AITUM_MIN_OBS):
        warn(cfg, f"  OBS {_obs_version_str(cfg) or '?'} is older than the "
                  f"{'.'.join(map(str, AITUM_MIN_OBS))}+ the Aitum plugins require; skipping")
        return Result(True, "aitum plugins skipped (OBS too old)")

    if cfg.dry_run:
        return Result(True, "aitum plugins would be installed")

    try:
        for meta in AITUM_PLUGINS:
            if plugin_matches(plugins_root / meta["name"], meta["version"]):
                continue
            _install_aitum_plugin(cfg, plugins_root, meta)
    except Exception as e:
        bail(cfg, f"Aitum plugin install failed ({e}) — aborting setup")

    _restart_obs_for_plugin(cfg)
    return Result(True, "Aitum plugins installed")


def _install_aitum_plugin(cfg: SetupConfig, plugins_root: pathlib.Path, meta: dict) -> None:
    """Download/verify/extract/relocate a single Aitum plugin .deb."""
    name, version = meta["name"], meta["version"]
    tmp = pathlib.Path("/tmp") / f"oink-{name}-{version}.deb"
    staging = pathlib.Path("/tmp") / f"oink-{name}-extract-{version}"
    try:
        run(cfg, "curl", "-fsSL", "-o", str(tmp), meta["url"])

        digest = hashlib.sha256(tmp.read_bytes()).hexdigest()
        if digest != meta["sha256"]:
            raise RuntimeError(f"{name} checksum mismatch (got {digest[:12]}…)")

        run(cfg, "rm", "-rf", str(staging))
        run(cfg, "mkdir", "-p", str(staging))
        run(cfg, "dpkg-deb", "-x", str(tmp), str(staging))

        so = _find_deb_so(staging / "usr/lib", name)
        if so is None:
            raise RuntimeError(f"{name} .deb contained no {name}.so")

        dest = plugins_root / name
        # Replace any existing copy wholesale on a version change (no stale .so).
        run(cfg, "rm", "-rf", str(dest))
        run(cfg, "mkdir", "-p", str(dest / "bin" / "64bit"))
        run(cfg, "cp", str(so), str(dest / "bin" / "64bit" / f"{name}.so"))

        share = staging / "usr/share/obs/obs-plugins" / name
        if share.is_dir():
            run(cfg, "mkdir", "-p", str(dest / "data"))
            run(cfg, "cp", "-a", f"{share}/.", str(dest / "data"))

        (dest / PLUGIN_VERSION_MARKER).write_text(version + "\n")
        run(cfg, "chown", "-R", f"{cfg.obs_user}:{cfg.obs_user}", str(dest))
        info(cfg, f"  → installed {name} v{version}")
    finally:
        tmp.unlink(missing_ok=True) if tmp.exists() else None
        shutil.rmtree(staging, ignore_errors=True) if staging.exists() else None


def _find_deb_so(root: pathlib.Path, name: str) -> pathlib.Path | None:
    """First <name>.so under a deb's usr/lib tree (arch-agnostic triplet)."""
    if not root.is_dir():
        return None
    for so in root.rglob(f"{name}.so"):
        return so
    return None


def _restart_obs_for_plugin(cfg: SetupConfig) -> None:
    """Restart oink-obs (if active) so a newly installed plugin is loaded."""
    if run_ok(cfg, "systemctl", "is-active", "--quiet", "oink-obs"):
        info(cfg, "  → restarting oink-obs to load the plugin")
        run(cfg, "systemctl", "restart", "oink-obs", check=False)


def section_obs_websocket(cfg: SetupConfig, state: HostState) -> Result:
    """§5  obs-websocket password + config. Password flows to later phases via state."""
    info(cfg, f"{Phase.OBS_WEBSOCKET.section_marker}  Generating obs-websocket password…")
    pw_file = cfg.obs_ws / "password"
    if pw_file.exists():
        pw = pw_file.read_text().strip()
        info(cfg, f"  → password already exists: {pw}")
    else:
        pw = secrets.token_urlsafe(18)
        if not cfg.dry_run:
            pw_file.write_text(pw)
        info(cfg, f"  → password: {pw}")
    # Owner-only: these files hold the obs-websocket password.
    if not cfg.dry_run and pw_file.exists():
        pw_file.chmod(0o600)

    # Native obs-websocket reads its server config from plugin_config/obs-websocket
    # config.json. Preseed the full schema (mirrors the LXC reference) so the
    # password is set even before the first launch; the oink-obs unit also passes
    # --websocket_password as a belt-and-suspenders override.
    cfg_file = cfg.obs_ws / "config.json"
    ws_cfg = {
        "alerts_enabled": False,
        "auth_required": True,
        "first_load": False,
        "server_enabled": True,
        "server_password": pw,
        "server_port": OBS_WS_PORT,
    }
    if cfg.dry_run:
        info(cfg, "  → Would write obs-websocket config.json (server_password set)")
    elif not cfg_file.exists():
        cfg_file.parent.mkdir(parents=True, exist_ok=True)
        cfg_file.write_text(json.dumps(ws_cfg, indent=2) + "\n")
        info(cfg, "  → wrote obs-websocket config.json (server_password set)")
    else:
        # Converge only the keys we manage: leave the file untouched when they
        # already match, and preserve any fields OBS added/edited at runtime.
        try:
            existing = json.loads(cfg_file.read_text())
        except (json.JSONDecodeError, OSError):
            existing = {}
        if isinstance(existing, dict) and all(existing.get(k) == v for k, v in ws_cfg.items()):
            info(cfg, "  → obs-websocket config.json already correct")
        else:
            merged = {**(existing if isinstance(existing, dict) else {}), **ws_cfg}
            cfg_file.write_text(json.dumps(merged, indent=2) + "\n")
            info(cfg, "  → updated obs-websocket config.json (server_password set)")

    # OBS runs as obsuser and may rewrite its websocket files; hand the plugin
    # dir (password + config.json) to it.
    if not cfg.dry_run:
        run(cfg, "chown", "-R", f"{cfg.obs_user}:{cfg.obs_user}", str(cfg.obs_ws))
        # config.json also embeds server_password — owner-only like the password file.
        if cfg_file.exists():
            cfg_file.chmod(0o600)

    state.obs_password = pw
    return Result(True, "obs-websocket configured")


def section_oink_obs(cfg: SetupConfig, state: HostState) -> Result:
    """§6  Install oink-obs.service + window-maximize + recording-pin helpers."""
    info(cfg, f"{Phase.OINK_OBS.section_marker}  Installing oink-obs.service…")
    pw = state.obs_password
    if not pw:
        bail(cfg, "obs-websocket password missing (run section 5 first)")

    if not cfg.dry_run:
        # Internal helpers live off-PATH; only `oink` (symlink below) is user-facing.
        OINK_LIBEXEC.mkdir(parents=True, exist_ok=True)
        pathlib.Path(OINK_LIBEXEC / "oink-obs-maximize.sh").write_text(cfg.template("oink-obs-maximize.sh"))
        os.chmod(OINK_LIBEXEC / "oink-obs-maximize.sh", 0o755)
        # Recording-path pinner (runs before every OBS launch + from the stack phase)
        pathlib.Path(OINK_LIBEXEC / "oink-pin-recordings.sh").write_text(cfg.template("oink-pin-recordings.sh"))
        os.chmod(OINK_LIBEXEC / "oink-pin-recordings.sh", 0o755)
        # `oink` on PATH → the repo's oink.py (run as root; works from any cwd).
        OINK_CLI.unlink(missing_ok=True)
        OINK_CLI.symlink_to(BASE_DIR.parent / "oink.py")
        # Loopback-only port guard: obs-websocket listens on 0.0.0.0:4455 with no
        # bind-address option, so block public inbound via a small nftables unit.
        fw_script = OINK_LIBEXEC / "oink-firewall.sh"
        fw_script.write_text(cfg.template("oink-firewall.sh"))
        os.chmod(fw_script, 0o755)

    fw_unit = cfg.template("oink-firewall.service").replace("$OINK_LIBEXEC", str(OINK_LIBEXEC))
    if not cfg.dry_run:
        fw_path = pathlib.Path("/etc/systemd/system/oink-firewall.service")
        fw_path.write_text(fw_unit)
        fw_path.chmod(0o644)
    run(cfg, "systemctl", "daemon-reload")
    run(cfg, "systemctl", "enable", "oink-firewall")
    # Restart (not `enable --now`): the unit is an active RemainAfterExit
    # oneshot, so `--now` would not re-run ExecStart and a changed script/unit
    # (e.g. after an upgrade) would sit stale until reboot. Restart re-applies
    # the table from the current script.
    run(cfg, "systemctl", "restart", "oink-firewall")

    # Write unit file (variable-expanded — must NOT be heredoc-style)
    # Software GL is only forced on hosts without the NVIDIA driver: there is
    # no other GL stack there, and forcing it keeps CEF from probing GPU paths.
    software_gl = "" if _nvidia_driver_installed(cfg) else "Environment=LIBGL_ALWAYS_SOFTWARE=1"
    unit = cfg.template("oink-obs.service").replace(
        "$SOFTWARE_GL_ENV", software_gl).replace(
        "$OINK_USER", cfg.obs_user).replace(
        "$OINK_HOME", str(cfg.obs_home)).replace("$PW", pw).replace(
        "$RECORDING_DIR", str(cfg.recording_dir)).replace(
        "$OINK_LIBEXEC", str(OINK_LIBEXEC)).replace(
        "$STACK_DIR", str(cfg.stack_dir))
    if not cfg.dry_run:
        # 0600: the unit embeds --websocket_password=$PW, which local users
        # must not read (the runtime user's home is 0750 but units are root-owned).
        unit_path = pathlib.Path("/etc/systemd/system/oink-obs.service")
        unit_path.write_text(unit)
        unit_path.chmod(0o600)
    run(cfg, "systemctl", "daemon-reload")
    run(cfg, "systemctl", "enable", "--now", "oink-obs")
    # `enable --now` won't restart an already-active unit, so force a restart
    # to relaunch OBS (e.g. after §4 re-scaffolds config or the golden profile
    # is restored). Mirror of the oink-guac restart below.
    run(cfg, "systemctl", "restart", "oink-obs")
    return Result(True)


def section_obs_scenes(cfg: SetupConfig, state: HostState) -> Result:
    """§6b  Create the default OBS scenes (main/brb/privacy/offline/low-br).

    Runs after oink-obs is up: waits for the obs-websocket port, then drives
    OBS over ws to create the default scenes and set "main" as the current
    scene. NOALBS is configured (stack/noalbs/config.json) to switch between
    these scene names, so they must exist or auto-switching is a no-op.
    """
    info(cfg, f"{Phase.OBS_SCENES.section_marker} Configuring default OBS scenes…")
    scenes_helper = str(OINK_LIBEXEC / "oink-scenes.py")
    if not cfg.dry_run:
        pathlib.Path(scenes_helper).write_text(cfg.template("scenes.py"))
        os.chmod(scenes_helper, 0o755)
    info(cfg, f"  → wrote {scenes_helper}")

    if cfg.dry_run:
        info(cfg, "  [dry-run] Would create default OBS scenes over the websocket")
        return Result(True)

    info(cfg, f"  → waiting for OBS websocket on :{OBS_WS_PORT}…")
    if not wait_port(OBS_WS_PORT, OBS_WS_TIMEOUT):
        warn(cfg, "  OBS websocket did not come up in time; skipping scene setup")
        return Result(True, "scene setup skipped (websocket timeout)")

    pw_file = cfg.obs_ws / "password"
    r = run(cfg, "python3", scenes_helper, str(pw_file),
            "--recording-dir", str(cfg.recording_dir), check=False, capture=False)
    if r.returncode != 0:
        warn(cfg, "  scene setup failed (see output above)")
    return Result(True)


def section_oink_vnc(cfg: SetupConfig, state: HostState) -> Result:
    """§7  Install oink-vnc.service (x11vnc bound to loopback)."""
    info(cfg, f"{Phase.OINK_VNC.section_marker}  Installing oink-vnc.service (listen 127.0.0.1)…")
    unit_path = pathlib.Path("/etc/systemd/system/oink-vnc.service")
    content = cfg.template("oink-vnc.service")
    changed = cfg.dry_run or not unit_path.exists() or unit_path.read_text() != content
    if not cfg.dry_run:
        unit_path.write_text(content)
    run(cfg, "systemctl", "daemon-reload")
    run(cfg, "systemctl", "enable", "oink-vnc")
    # Restart only when the unit changed (it holds a live remote-desktop
    # session); otherwise ensure it is running without dropping sessions.
    if changed:
        run(cfg, "systemctl", "restart", "oink-vnc")
    else:
        run(cfg, "systemctl", "start", "oink-vnc")
    return Result(True)


def _node_22_ok(cfg: SetupConfig) -> bool:
    """True when Node >= 22.12.0 and npm are both available."""
    v = node_semver(cfg)
    return v is not None and v >= (22, 12, 0) and run_ok(cfg, "npm", "--version")


def section_guacamole(cfg: SetupConfig, state: HostState) -> Result:
    """§8  Native guacd (distro unit) + guacamole-lite tunnel."""
    info(cfg, f"{Phase.GUACAMOLE.section_marker}  Installing Guacamole remote-desktop tunnel…")

    # Native guacd comes from the §1 apt pass (installed only when Guacamole is
    # enabled). The distro `guacd.service` binds 127.0.0.1:4822 (/etc/default/guacd)
    # and runs as the `guacd` user — enable it rather than manage a custom unit,
    # so package updates keep guacd current. Both guacd and x11vnc run on the
    # host, so VNC is reached at 127.0.0.1.
    #
    # Gotcha: guacd daemonizes by
    # default, so a hand-rolled Type=simple unit running bare `guacd` lets the
    # systemd main PID exit (treated as failure → restart loop) while the fork
    # holds :4822. The distro unit avoids this: it is Type=forking with a
    # PIDFile (`guacd -p /var/run/guacd/guacd.pid`); verified stable on the
    # deployment host (NRestarts=0). Keep the distro unit; if a custom
    # foreground unit is ever required, run `guacd -f`.
    if not run_ok(cfg, "dpkg", "-s", "guacd"):
        warn(cfg, "  → guacd not installed (was §1's apt pass declined?); remote desktop will be unavailable")
        return Result(True, "guacamole skipped (guacd missing)")
    run(cfg, "systemctl", "enable", "--now", "guacd")

    # Node.js + guacamole-lite
    guac_modules = cfg.guac_dir / "node_modules/guacamole-lite"
    # File drop directory for OBS media
    run(cfg, "mkdir", "-p", str(cfg.dep_dir))
    run(cfg, "chown", f"{cfg.obs_user}:{OINK_GROUP}", str(cfg.dep_dir))

    if not guac_modules.exists():
        # Node 22 is installed by §1 (NodeSource in the single apt pass). Guard
        # here so a host that skipped §1's apt pass fails loudly rather than
        # leaving a silently broken tunnel.
        if not _node_22_ok(cfg):
            if cfg.dry_run:
                info(cfg, "  [dry-run] Node check deferred — real run needs Node >= 22.12 + npm")
            else:
                bail(cfg, "Node.js >= 22.12 with npm is required for guacamole-lite but is not available.\n"
                     "It should have been installed by the §1 apt pass. Install it manually:\n"
                     "  curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash - "
                     "&& sudo apt-get install -y nodejs\n"
                     "or unpack the official tarball into /usr/local:\n"
                     "  curl -fsSL https://nodejs.org/dist/v22.12.0/node-v22.12.0-linux-x64.tar.xz "
                     "| sudo tar -xJ -C /usr/local --strip-components=1")

        if not confirm(cfg, "Install guacamole-lite (npm)?"):
            info(cfg, "  → Skipping guacamole-lite install")
        else:
            run(cfg, "mkdir", "-p", str(cfg.guac_dir / "lib"))
            # Pinned deps ship as a template (guac-package.json) instead of
            # `npm install <pkg>` latest, so builds are reproducible.
            if not cfg.dry_run:
                (cfg.guac_dir / "package.json").write_text(cfg.template("guac-package.json"))
            run(cfg, "bash", "-c",
                f"cd '{cfg.guac_dir}' && npm install --omit=dev")

        # Self-host browser-side Guacamole library
        run(cfg, "bash", "-c",
            "curl -sL https://registry.npmjs.org/guacamole-common-js/-/guacamole-common-js-1.5.0.tgz"
            " | tar xz -C /tmp")
        run(cfg, "python3", "-c", (
            f"open('{cfg.guac_dir}/lib/guac.min.js','w').write(\n"
            "  open('/tmp/package/dist/cjs/guacamole-common.min.js').read()\n"
            "    .replace(',module.exports=Guacamole;','')\n"
            ")"
        ))
        run(cfg, "node", "--check", str(cfg.guac_dir / "lib/guac.min.js"))
    else:
        info(cfg, "  → guacamole-lite already installed")

    # Generate AES key for token encryption
    guac_key = secrets.token_hex(16)

    # server.js (always overwrite). guacd reaches x11vnc on the host loopback,
    # so the VNC token hostname is 127.0.0.1.
    server_js = cfg.template("server.js").replace("$GUAC_KEY", guac_key)
    if not cfg.dry_run:
        (cfg.guac_dir / "server.js").write_text(server_js)
    info(cfg, "  → wrote server.js")

    # guac-token.js — token minting/validation helpers required by server.js.
    if not cfg.dry_run:
        (cfg.guac_dir / "guac-token.js").write_text(cfg.template("guac-token.js"))
    info(cfg, "  → wrote guac-token.js")

    # client.html + preview HTML files (always overwrite)
    for name in ("client.html", "preview-client.html", "preview-dashboard.html"):
        if not cfg.dry_run:
            (cfg.guac_dir / name).write_text(cfg.template(name))
    info(cfg, "  → wrote client.html, preview-client.html, preview-dashboard.html")

    # The tunnel runs as the runtime user; hand the whole guac tree to it.
    run(cfg, "chown", "-R", f"{cfg.obs_user}:{cfg.obs_user}", str(cfg.guac_dir))

    # systemd unit
    unit = cfg.template("oink-guac.service").replace("$OINK_USER", cfg.obs_user).replace(
        "$GUAC_DIR", str(cfg.guac_dir)
    )
    if not cfg.dry_run:
        pathlib.Path("/etc/systemd/system/oink-guac.service").write_text(unit)
    run(cfg, "systemctl", "daemon-reload")
    run(cfg, "systemctl", "enable", "--now", "oink-guac")
    # server.js above always re-encodes with a fresh key. `enable --now` won't
    # restart an already-active unit, so force a restart to load the new key.
    run(cfg, "systemctl", "restart", "oink-guac")
    state.guac_key = guac_key
    return Result(True, "guacamole installed")
