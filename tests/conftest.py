# SPDX-FileCopyrightText: 2026 OpenIRLNodeKit contributors
# SPDX-License-Identifier: AGPL-3.0-or-later
"""Shared pytest fixtures.

The scripts package is a set of top-level modules (``from constants import ...``)
run from the scripts/ directory, so we add scripts/ to sys.path here so the
tests can import them the same way the CLI does.
"""

from __future__ import annotations

import pathlib
import sys

import pytest

SCRIPT_DIR = pathlib.Path(__file__).resolve().parent.parent / "scripts"
if str(SCRIPT_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPT_DIR))


@pytest.fixture
def cfg():
    """A minimal, valid SetupConfig for exercising scripts logic."""
    from models import SetupConfig
    return SetupConfig(
        user="ubuntu",
        home=pathlib.Path("/home/ubuntu"),
        obs_user="obsuser",
        obs_home=pathlib.Path("/home/obsuser"),
        obs_cfg=pathlib.Path("/home/obsuser/.config/obs-studio"),
        obs_ws=pathlib.Path("/home/obsuser/.config/obs-studio/plugin_config/obs-websocket"),
        global_ini=pathlib.Path("/g/global.ini"),
        user_ini=pathlib.Path("/ui/user.ini"),
        user_ini_root=pathlib.Path("/uir/user.ini"),
        guac_dir=pathlib.Path("/home/obsuser/guac-spike"),
        dep_dir=pathlib.Path("/home/obsuser/dependencies"),
        recording_dir=pathlib.Path("/home/obsuser/recordings"),
        stack_dir=pathlib.Path("/home/obsuser/oink/stack"),
        distro_id="ubuntu",
        distro_version="24.04",
        dry_run=False,
        auto_yes=False,
        verbose=False,
        started_at=0.0,
    )

