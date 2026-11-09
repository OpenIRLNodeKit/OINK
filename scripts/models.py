# SPDX-FileCopyrightText: 2026 OpenIRLNodeKit contributors
# SPDX-License-Identifier: AGPL-3.0-or-later
"""Data types: Phase, SetupConfig, HostState, Result."""

from __future__ import annotations

import argparse
import json
import os
import pathlib
import time
from dataclasses import dataclass, field
from enum import Enum

from constants import OBS_HOME, OBS_PROFILE, OBS_USER, STATE_DIR, STATE_FILE, TEMPLATE_DIR


class Phase(Enum):
    BASE_PACKAGES = "base_packages"
    NVIDIA_DRIVER = "nvidia_driver"
    OBS_USER = "obs_user"
    DUMMY_DISPLAY = "dummy_display"
    OINK_DISPLAY = "oink_display"
    OBS_INSTALL = "obs_install"
    OBS_GOLDEN = "obs_golden"
    OBS_IRL_SOURCE = "obs_irl_source"
    AITUM_PLUGINS = "aitum_plugins"
    OBS_WEBSOCKET = "obs_websocket"
    OINK_OBS = "oink_obs"
    OBS_SCENES = "obs_scenes"
    OBS_VERTICAL = "obs_vertical"
    OINK_VNC = "oink_vnc"
    GUACAMOLE = "guacamole"
    VERIFY = "verify"

    @property
    def display_name(self) -> str:
        return self.value.replace("_", " ").title()

    @property
    def section_marker(self) -> str:
        markers = {
            Phase.BASE_PACKAGES: "§1",
            Phase.NVIDIA_DRIVER: "§1c",
            Phase.OBS_USER: "§1b",
            Phase.DUMMY_DISPLAY: "§2",
            Phase.OINK_DISPLAY: "§3",
            Phase.OBS_INSTALL: "§4",
            Phase.OBS_GOLDEN: "§4b",
            Phase.OBS_IRL_SOURCE: "§4c",
            Phase.AITUM_PLUGINS: "§4d",
            Phase.OBS_WEBSOCKET: "§5",
            Phase.OINK_OBS: "§6",
            Phase.OBS_SCENES: "§6b",
            Phase.OBS_VERTICAL: "§6c",
            Phase.OINK_VNC: "§7",
            Phase.GUACAMOLE: "§8",
            Phase.VERIFY: "✓",
        }
        return markers.get(self, self.value)


@dataclass(frozen=True)
class SetupConfig:
    user: str
    home: pathlib.Path
    obs_user: str
    obs_home: pathlib.Path
    obs_cfg: pathlib.Path
    obs_ws: pathlib.Path
    global_ini: pathlib.Path
    user_ini: pathlib.Path
    user_ini_root: pathlib.Path
    guac_dir: pathlib.Path
    dep_dir: pathlib.Path
    recording_dir: pathlib.Path
    stack_dir: pathlib.Path
    distro_id: str
    distro_version: str
    dry_run: bool
    auto_yes: bool
    force: bool = False
    verbose: bool = False
    started_at: float = 0.0

    @classmethod
    def from_args(cls, args: argparse.Namespace) -> SetupConfig:
        oink_user = os.environ.get("SUDO_USER", "ubuntu")
        oink_home = pathlib.Path(f"/home/{oink_user}")
        obs_user = os.environ.get("OBS_USER") or OBS_USER
        obs_home = OBS_HOME if obs_user == OBS_USER else pathlib.Path(f"/home/{obs_user}")
        obs_cfg = obs_home / ".config/obs-studio"
        obs_ws = obs_cfg / "plugin_config/obs-websocket"
        guac_dir = obs_home / "guac-spike"

        release = {}
        os_release = pathlib.Path("/etc/os-release")
        if os_release.exists():
            for line in os_release.read_text().splitlines():
                if "=" in line:
                    k, v = line.split("=", 1)
                    release[k.strip()] = v.strip().strip('"')

        distro_id = release.get("ID", "")

        return cls(
            user=oink_user,
            home=oink_home,
            obs_user=obs_user,
            obs_home=obs_home,
            obs_cfg=obs_cfg,
            obs_ws=obs_ws,
            global_ini=obs_cfg / "global.ini",
            user_ini=obs_cfg / f"basic/profiles/{OBS_PROFILE}/user.ini",
            user_ini_root=obs_cfg / "user.ini",
            guac_dir=guac_dir,
            dep_dir=obs_home / "dependencies",
            recording_dir=obs_home / "recordings",
            stack_dir=obs_home / "oink" / "stack",
            distro_id=distro_id,
            distro_version=release.get("VERSION_ID", ""),
            dry_run=args.dry_run,
            auto_yes=args.yes,
            force=getattr(args, "force", False),
            verbose=getattr(args, "verbose", False),
            started_at=time.time(),
        )

    def template(self, name: str) -> str:
        return (TEMPLATE_DIR / name).read_text()


@dataclass
class HostState:
    completed_phases: set[Phase] = field(default_factory=set)
    obs_version: str = ""
    obs_password: str = ""
    guac_key: str = ""
    # phase.value -> sha256 of that phase's template/data inputs at completion.
    # Lets `oink setup` re-run a phase whose template changed even though the
    # state flag still says done (see oink._phase_fingerprint).
    phase_fingerprints: dict[str, str] = field(default_factory=dict)

    @classmethod
    def load(cls) -> HostState:
        if not STATE_FILE.exists():
            return cls()
        try:
            data = json.loads(STATE_FILE.read_text())
            return cls(
                completed_phases={Phase(p) for p in data.get("completed_phases", [])},
                obs_version=data.get("obs_version", ""),
                obs_password=data.get("obs_password", ""),
                guac_key=data.get("guac_key", ""),
                phase_fingerprints=dict(data.get("phase_fingerprints", {})),
            )
        except Exception:
            return cls()

    def save(self) -> None:
        STATE_DIR.mkdir(parents=True, exist_ok=True)
        # State carries obs_password + guac_key; keep dir/file owner-only.
        os.chmod(STATE_DIR, 0o700)
        data = {
            "completed_phases": [p.value for p in self.completed_phases],
            "obs_version": self.obs_version,
            "obs_password": self.obs_password,
            "guac_key": self.guac_key,
            "phase_fingerprints": self.phase_fingerprints,
        }
        # Atomic write: write a temp file, then rename over the state file.
        tmp_file = STATE_FILE.with_suffix(".tmp")
        tmp_file.write_text(json.dumps(data, indent=2))
        os.chmod(tmp_file, 0o600)
        tmp_file.replace(STATE_FILE)

    def is_done(self, phase: Phase) -> bool:
        return phase in self.completed_phases

    def mark_done(self, phase: Phase) -> None:
        self.completed_phases.add(phase)


@dataclass
class Result:
    success: bool
    message: str = ""
