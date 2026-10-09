# SPDX-FileCopyrightText: 2026 OpenIRLNodeKit contributors
# SPDX-License-Identifier: AGPL-3.0-or-later
"""OBS profile + scene-collection provisioning for the OINK host-setup phase.

This module owns the §6c vertical-canvas phase and the helpers that converge the
OBS profile/scene collection to the installed as the default. It was carved out
of ``scripts/sections.py`` to keep that module from growing past an atomically
reviewable size; the shared OBS version/plugin check helpers live here too so
neither module has to import the other (no circular import).
"""

from __future__ import annotations

import configparser
import io
import json
import pathlib
import re
import shutil

from constants import (
    AITUM_VERTICAL_MIN_OBS,
    OBS_PROFILE,
    OBS_WS_PORT,
    OBS_WS_TIMEOUT,
    VERTICAL_CANVAS_NAME,
    VERTICAL_HEIGHT,
    VERTICAL_SCENE_COLLECTION,
    VERTICAL_TEMPLATE,
    VERTICAL_WIDTH,
)
from logui import info, warn
from models import HostState, Phase, Result, SetupConfig
from obs_ws import connect as _ws_connect, request as _ws_request
from process import run, run_ok, wait_port


def _plugin_present(plugin_dir) -> bool:
    """True when a loadable plugin .so already sits under the plugin dir."""
    return any(plugin_dir.rglob("*.so"))


# Marker written next to an installed plugin recording the pinned version it was
# built from, so `oink setup` can reinstall when components.json bumps.
PLUGIN_VERSION_MARKER = ".oink-version"


def plugin_version(plugin_dir) -> str:
    """The version recorded for an installed plugin, or "" when unknown."""
    try:
        return (plugin_dir / PLUGIN_VERSION_MARKER).read_text().strip()
    except OSError:
        return ""


def plugin_matches(plugin_dir, version: str) -> bool:
    """True when a loadable plugin pinned to `version` is already installed."""
    return _plugin_present(plugin_dir) and plugin_version(plugin_dir) == version


# First dotted major.minor[.patch] token anywhere in `obs --version` output.
_VERSION_RE = re.compile(r"\b(\d+)\.(\d+)(?:\.(\d+))?\b")


def _obs_semver_tuple(stdout: str) -> tuple[int, int, int] | None:
    """(major, minor, patch) from `obs --version` output, patch defaulting to 0."""
    m = _VERSION_RE.search(stdout)
    if not m:
        return None
    return (int(m.group(1)), int(m.group(2)), int(m.group(3) or 0))


def _obs_version_str(cfg: SetupConfig) -> str:
    """Numeric OBS version ("30.2.2") from `obs --version`, or ""."""
    r = run(cfg, "obs", "--version", capture=True, check=False)
    stdout = (r.stdout if r else "") or ""
    v = _obs_semver_tuple(stdout)
    return ".".join(map(str, v)) if v else ""


def _obs_semver_at_least(cfg: SetupConfig, minimum: tuple[int, int]) -> bool:
    """True when `obs --version` reports >= minimum (major, minor)."""
    r = run(cfg, "obs", "--version", capture=True, check=False)
    stdout = (r.stdout if r else "") or ""
    v = _obs_semver_tuple(stdout)
    return v is not None and (v[0], v[1]) >= minimum


def section_obs_vertical(cfg: SetupConfig, state: HostState) -> Result:
    """§6c  Provision the Aitum Vertical canvas + link vertical scenes to main.

    Writes a golden scene-collection template that defines the "Aitum Vertical"
    canvas (1080×1920) with one scene per default main scene, each containing a
    nested scene source mirroring its matching main scene (so content
    auto-syncs). It also links each main scene to its vertical counterpart by
    setting the plugin's `settings.canvas` array on the main scene source —
    switching the main program scene then switches the vertical canvas scene.

    Runs after oink-obs is up. The template replaces the whole scene collection
    (OBS collection import is replace-not-merge), so this phase owns the
    collection. Degrades gracefully: warns and skips when the vertical-canvas
    plugin is absent or OBS is too old to support the canvas system.
    """
    info(cfg, f"{Phase.OBS_VERTICAL.section_marker} Configuring vertical canvas…")

    # The Aitum vertical-canvas plugin (installed in §4d) must be present and
    # loaded for the canvas system to work; skip with a warning otherwise.
    plugins_root = cfg.obs_cfg / "plugins"
    if not _plugin_present(plugins_root / "vertical-canvas"):
        warn(cfg, "  vertical-canvas plugin not present; skipping vertical setup")
        return Result(True, "vertical setup skipped (plugin missing)")

    if not _obs_semver_at_least(cfg, AITUM_VERTICAL_MIN_OBS):
        warn(cfg, f"  OBS {_obs_version_str(cfg) or '?'} is older than the "
                  f"{'.'.join(map(str, AITUM_VERTICAL_MIN_OBS))}+ the vertical canvas "
                  "requires; skipping")
        return Result(True, "vertical setup skipped (OBS too old)")

    if cfg.dry_run:
        info(cfg, "  → would write vertical scene-collection template")
        return Result(True, "vertical setup would be configured")

    # OBS resolves the current profile + scene collection from the top-level
    # ~/.config/obs-studio/user.ini [Basic] block, and re-saves that file (and
    # the active scene collection) on shutdown. So config that must survive a
    # restart — the oink collection, the oink profile, and the [Basic] pointer —
    # is written while OBS is stopped, in a single window, before OBS starts.
    obs_active = run_ok(cfg, "systemctl", "is-active", "--quiet", "oink-obs")
    if not _oink_default_configured(cfg):
        if obs_active:
            info(cfg, "  → stopping oink-obs to write the oink config")
            run(cfg, "systemctl", "stop", "oink-obs", check=False)

        _ensure_oink_profile(cfg)
        _write_oink_collection(cfg)
        _set_oink_default(cfg)
        _remove_untitled(cfg)
        _write_ui_default(cfg)

        info(cfg, "  → starting oink-obs to load the oink profile + collection")
        run(cfg, "systemctl", "start", "oink-obs", check=False)
    else:
        info(cfg, "  → oink profile + collection already configured")

    # Wait for the websocket and confirm the vertical canvas came up.
    info(cfg, f"  → waiting for OBS websocket on :{OBS_WS_PORT}…")
    if not wait_port(OBS_WS_PORT, OBS_WS_TIMEOUT):
        warn(cfg, "  OBS websocket did not come up in time; vertical setup may not have applied")
        return Result(True, "vertical setup degraded (websocket timeout)")

    if not _vertical_canvas_live(cfg):
        warn(cfg, "  vertical canvas did not come up; check the vertical-canvas plugin")
        return Result(True, "vertical setup degraded (canvas not detected)")

    return Result(True, "vertical canvas configured")


def _ensure_oink_profile(cfg: SetupConfig) -> None:
    """Make the oink OBS profile complete on disk: user.ini (golden) + basic.ini.

    The profile dir is scaffolded in §4 and the golden user.ini is installed by
    oink-obs.service's ExecStartPre, but the profile also needs a basic.ini (the
    video/output settings). Copy it from the current Untitled profile if present
    so the oink profile inherits the working output config; otherwise leave it
    for OBS / oink-pin-recordings.sh to generate.
    """
    profile_dir = cfg.obs_cfg / "basic" / "profiles" / OBS_PROFILE
    profile_dir.mkdir(parents=True, exist_ok=True)

    # Golden user.ini (UI geometry/docks). Installed only when the profile is
    # fresh (missing) — once present, runtime UI state (dock layout, Aitum
    # docks) is left alone so it survives restarts and setup re-runs.
    golden = cfg.obs_home / "user.ini.golden"
    if golden.exists():
        dest = profile_dir / "user.ini"
        if not dest.exists():
            dest.write_text(golden.read_text())
            run(cfg, "chown", f"{cfg.obs_user}:{cfg.obs_user}", str(dest))
    else:
        info(cfg, "  → golden user.ini not found; skipping profile user.ini install")

    basic_ini = profile_dir / "basic.ini"
    if not basic_ini.exists():
        untitled_basic = cfg.obs_cfg / "basic" / "profiles" / "Untitled" / "basic.ini"
        if untitled_basic.exists():
            basic_ini.write_text(untitled_basic.read_text())
            run(cfg, "chown", f"{cfg.obs_user}:{cfg.obs_user}", str(basic_ini))
            info(cfg, f"  → copied Untitled basic.ini → {basic_ini} (oink profile)")

    run(cfg, "chown", "-R", f"{cfg.obs_user}:{cfg.obs_user}", str(profile_dir))


def _write_oink_collection(cfg: SetupConfig) -> None:
    """Write the golden vertical scene-collection template as the oink collection."""
    scenes_dir = cfg.obs_cfg / "basic" / "scenes"
    collection_file = scenes_dir / f"{VERTICAL_SCENE_COLLECTION}.json"
    scenes_dir.mkdir(parents=True, exist_ok=True)
    collection_file.write_text(cfg.template(VERTICAL_TEMPLATE))
    run(cfg, "chown", f"{cfg.obs_user}:{cfg.obs_user}", str(collection_file))
    info(cfg, f"  → wrote {collection_file} (vertical canvas template)")


def _write_ui_default(cfg: SetupConfig) -> None:
    """Apply the golden OBS UI layout (top-level user.ini) so every deployment
    boots OBS with the reference dock arrangement — the Aitum Multistream and
    Vertical Canvas docks docked into the main window (this OBS 32.2 build keeps
    the dock layout in the top-level user.ini, not the profile user.ini).

    Runs while OBS is stopped during §6c. The top-level user.ini must already
    exist — OBS creates it on its first launch (§6) — because pre-creating it
    before the first run breaks OBS's config migration.
    """
    ini = cfg.user_ini_root
    if not ini.exists():
        warn(cfg, "  → top-level user.ini missing; skipping UI layout default")
        return
    text = cfg.template("user.ini.top")
    if ini.read_text() == text:
        info(cfg, "  → UI layout already matches golden")
        return
    ini.write_text(text)
    run(cfg, "chown", f"{cfg.obs_user}:{cfg.obs_user}", str(ini))
    info(cfg, "  → wrote golden UI layout (top-level user.ini)")


def _ini_text(parser: configparser.ConfigParser) -> str:
    out = io.StringIO()
    parser.write(out)
    return out.getvalue()


def _set_oink_default(cfg: SetupConfig) -> None:
    """Rewrite the top-level OBS user.ini [Basic] so oink is the active profile + collection.

    OBS reads this file (App()->GetUserConfig()) at startup to resolve the current
    profile and scene collection. Editing it while OBS is stopped is equivalent to
    a websocket SetCurrentProfile/SetCurrentSceneCollection but deterministic and
    single-window.
    """
    ini = cfg.user_ini_root
    parser = _read_ini(ini)
    if parser is None:
        warn(cfg, f"  → could not parse {ini}; leaving it untouched")
        return
    if not parser.has_section("Basic"):
        parser.add_section("Basic")
    parser.set("Basic", "Profile", OBS_PROFILE)
    parser.set("Basic", "ProfileDir", OBS_PROFILE)
    parser.set("Basic", "SceneCollection", VERTICAL_SCENE_COLLECTION)
    parser.set("Basic", "SceneCollectionFile", f"{VERTICAL_SCENE_COLLECTION}.json")
    text = _ini_text(parser)
    if not ini.exists() or ini.read_text() != text:
        ini.write_text(text)
        info(cfg, "  → set current profile + scene collection to oink")
    else:
        info(cfg, "  → oink already the current profile + scene collection")


def _remove_untitled(cfg: SetupConfig) -> None:
    """Delete the orphaned Untitled profile + scene collection so they don't appear in OBS.

    OBS recreates nothing automatically: once oink is the recorded default and the
    Untitled profile dir + collection file are gone, they stay gone.
    """
    untitled_profile = cfg.obs_cfg / "basic" / "profiles" / "Untitled"
    if untitled_profile.is_dir():
        shutil.rmtree(untitled_profile)
        info(cfg, f"  → removed Untitled profile {untitled_profile}")

    for name in ("Untitled.json", "Untitled.json.bak"):
        f = cfg.obs_cfg / "basic" / "scenes" / name
        if f.exists():
            f.unlink()
            info(cfg, f"  → removed Untitled collection {f}")


def _read_ini(path: pathlib.Path) -> configparser.ConfigParser | None:
    """Read an ini file fresh (case-preserving options, no % interpolation).

    Returns None when the file exists but cannot be parsed, so a malformed OBS
    config is never rewritten.
    """
    parser = configparser.ConfigParser(interpolation=None)
    parser.optionxform = str
    if path.exists():
        try:
            parser.read(path)
        except configparser.Error:
            return None
    return parser


def _oink_default_configured(cfg: SetupConfig) -> bool:
    """True when OBS is set to load the oink profile + collection by default.

    Requires the oink collection file to exist AND the top-level user.ini [Basic]
    block to point the current profile + scene collection at oink. When false, the
    §6c phase (re)converges the oink profile/collection and removes Untitled.
    """
    if not _vertical_collection_configured(cfg):
        return False
    ini = cfg.user_ini_root
    if not ini.exists():
        return False
    parser = _read_ini(ini)
    if parser is None or not parser.has_section("Basic"):
        return False
    kv = {k.lower(): v for k, v in parser.items("Basic")}
    return (
        kv.get("profile") == OBS_PROFILE
        and kv.get("profiledir") == OBS_PROFILE
        and kv.get("scenecollection") == VERTICAL_SCENE_COLLECTION
        and kv.get("scenecollectionfile") == f"{VERTICAL_SCENE_COLLECTION}.json"
    )


def _vertical_collection_configured(cfg: SetupConfig) -> bool:
    """True when the scene collection already defines the Aitum Vertical canvas."""
    collection_file = cfg.obs_cfg / "basic" / "scenes" / f"{VERTICAL_SCENE_COLLECTION}.json"
    if not collection_file.exists():
        return False
    try:
        data = json.loads(collection_file.read_text())
    except (json.JSONDecodeError, OSError):
        return False
    canvases = data.get("canvases", []) or []
    return any(c.get("info", {}).get("name") == VERTICAL_CANVAS_NAME for c in canvases)


def _vertical_canvas_live(cfg: SetupConfig) -> bool:
    """True when OBS reports the Aitum Vertical canvas (or its scenes) live.

    Uses the vendor requests the vertical-canvas plugin registers via
    obs-websocket; falls back to checking the canvas list when available.
    """
    pw_file = cfg.obs_ws / "password"
    if not pw_file.exists():
        return False
    ws = None
    try:
        ws = _ws_connect(pw_file.read_text().strip())
        state = {"seq": 0}
        # The plugin's get_scenes vendor request succeeds only when the canvas is
        # present; absent, OBS returns an error status.
        resp = _ws_request(ws, "CallVendorRequest", {
            "vendorName": "aitum-vertical-canvas",
            "requestType": "get_scenes",
            "requestData": {"width": VERTICAL_WIDTH, "height": VERTICAL_HEIGHT},
        }, state)
        return resp.get("requestStatus", {}).get("code") == 100 and bool(
            resp.get("responseData", {}).get("scenes"))
    except Exception:
        return False
    finally:
        if ws is not None:
            try:
                ws.close()
            except Exception:
                pass
