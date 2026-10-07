# SPDX-FileCopyrightText: 2026 OpenIRLNodeKit contributors
# SPDX-License-Identifier: AGPL-3.0-or-later
"""Unit tests for scripts/models.py — data types & state (pure logic)."""

from __future__ import annotations

import json
import pathlib

import models
from models import HostState, Phase, Result, SetupConfig

# ── Phase ────────────────────────────────────────────────────────────────────

def test_phase_enum_members():
    values = [p.value for p in Phase]
    assert Phase.VERIFY in Phase
    assert "base_packages" in values
    assert "obs_irl_source" in values
    assert "aitum_plugins" in values
    assert "obs_vertical" in values
    assert "verify" in values


def test_phase_display_name():
    assert Phase.BASE_PACKAGES.display_name == "Base Packages"
    assert Phase.OBS_WEBSOCKET.display_name == "Obs Websocket"
    assert Phase.OBS_IRL_SOURCE.display_name == "Obs Irl Source"
    assert Phase.AITUM_PLUGINS.display_name == "Aitum Plugins"
    assert Phase.VERIFY.display_name == "Verify"


def test_phase_section_marker_known():
    assert Phase.BASE_PACKAGES.section_marker == "§1"
    assert Phase.OBS_GOLDEN.section_marker == "§4b"
    assert Phase.OBS_IRL_SOURCE.section_marker == "§4c"
    assert Phase.AITUM_PLUGINS.section_marker == "§4d"
    assert Phase.OBS_VERTICAL.section_marker == "§6c"
    assert Phase.VERIFY.section_marker == "✓"


# ── SetupConfig.from_args ────────────────────────────────────────────────

def _stub_args(**overrides):
    from argparse import Namespace
    base = dict(dry_run=False, yes=False, verbose=False)
    base.update(overrides)
    return Namespace(**base)


def test_from_args_without_os_release(monkeypatch):
    # Simulate a host with no readable /etc/os-release.
    monkeypatch.setenv("SUDO_USER", "alice")
    def fake_exists(self):  # noqa: N803
        return str(self) != "/etc/os-release"
    monkeypatch.setattr(pathlib.Path, "exists", fake_exists)

    cfg = SetupConfig.from_args(_stub_args(dry_run=True, yes=True))
    assert cfg.user == "alice"
    assert cfg.home == pathlib.Path("/home/alice")
    assert cfg.obs_user == "obsuser"
    assert cfg.obs_home == pathlib.Path("/home/obsuser")
    assert cfg.obs_cfg == pathlib.Path(
        "/home/obsuser/.config/obs-studio"
    )
    assert cfg.obs_ws == cfg.obs_cfg / "plugin_config/obs-websocket"
    assert cfg.guac_dir == pathlib.Path("/home/obsuser/guac-spike")
    assert cfg.dep_dir == pathlib.Path("/home/obsuser/dependencies")
    assert cfg.recording_dir == pathlib.Path("/home/obsuser/recordings")
    assert cfg.stack_dir == pathlib.Path("/home/obsuser/oink/stack")
    assert cfg.global_ini == cfg.obs_cfg / "global.ini"
    assert cfg.user_ini == cfg.obs_cfg / "basic/profiles/oink/user.ini"
    assert cfg.user_ini_root == cfg.obs_cfg / "user.ini"
    assert cfg.distro_id == ""
    assert cfg.distro_version == ""
    assert cfg.dry_run is True
    assert cfg.auto_yes is True


def test_from_args_verbose_flag(monkeypatch):
    monkeypatch.setenv("SUDO_USER", "alice")
    monkeypatch.setattr(pathlib.Path, "exists", lambda self: False)
    cfg = SetupConfig.from_args(_stub_args(verbose=True))
    assert cfg.verbose is True
    cfg2 = SetupConfig.from_args(_stub_args())
    assert cfg2.verbose is False


def test_from_args_default_verbose_missing_attr(monkeypatch):
    # Older callers (cleanup/status/users) build a Namespace without `verbose`.
    monkeypatch.setenv("SUDO_USER", "alice")
    monkeypatch.setattr(pathlib.Path, "exists", lambda self: False)
    from argparse import Namespace
    cfg = SetupConfig.from_args(Namespace(dry_run=False, yes=False))
    assert cfg.verbose is False


def test_from_args_custom_obs_user(monkeypatch):
    # The runtime user + home are overridable via the module-level constants.
    monkeypatch.setenv("SUDO_USER", "alice")
    monkeypatch.setattr(pathlib.Path, "exists", lambda self: False)
    monkeypatch.setattr(models, "OBS_USER", "camuser")
    monkeypatch.setattr(models, "OBS_HOME", pathlib.Path("/srv/cam"))
    cfg = SetupConfig.from_args(_stub_args())
    assert cfg.obs_user == "camuser"
    assert cfg.obs_home == pathlib.Path("/srv/cam")
    assert cfg.dep_dir == pathlib.Path("/srv/cam/dependencies")
    assert cfg.recording_dir == pathlib.Path("/srv/cam/recordings")
    assert cfg.stack_dir == pathlib.Path("/srv/cam/oink/stack")


def test_from_args_obs_user_env_override(monkeypatch):
    # OBS_USER from the environment (seeded by OINK_OBS_USER in .env) wins and
    # re-derives the runtime home/paths.
    monkeypatch.setenv("SUDO_USER", "alice")
    monkeypatch.setenv("OBS_USER", "camuser")
    monkeypatch.setattr(pathlib.Path, "exists", lambda self: False)
    cfg = SetupConfig.from_args(_stub_args())
    assert cfg.obs_user == "camuser"
    assert cfg.obs_home == pathlib.Path("/home/camuser")
    assert cfg.stack_dir == pathlib.Path("/home/camuser/oink/stack")


def test_from_args_parses_os_release(monkeypatch):
    monkeypatch.setenv("SUDO_USER", "ubuntu")
    content = 'ID=ubuntu\nVERSION_ID="24.04"\n'
    monkeypatch.setattr(
        pathlib.Path, "read_text", lambda self, **kw: content
    )
    def fake_exists(self):  # noqa: N803
        return True
    monkeypatch.setattr(pathlib.Path, "exists", fake_exists)

    cfg = SetupConfig.from_args(_stub_args())
    assert cfg.distro_id == "ubuntu"
    assert cfg.distro_version == "24.04"
    assert cfg.user == "ubuntu"


def test_from_args_default_user(monkeypatch):
    # No SUDO_USER set in the environment -> default "ubuntu".
    monkeypatch.delenv("SUDO_USER", raising=False)
    monkeypatch.setattr(pathlib.Path, "exists", lambda self: False)
    cfg = SetupConfig.from_args(_stub_args())
    assert cfg.user == "ubuntu"


def test_template_reads_from_template_dir(monkeypatch, tmp_path):
    tmpl = tmp_path / "sample.txt"
    tmpl.write_text("hello {{name}}")
    monkeypatch.setattr(pathlib.Path, "exists", lambda self: False)
    monkeypatch.setattr(models, "TEMPLATE_DIR", tmp_path)
    cfg = SetupConfig.from_args(_stub_args())
    assert cfg.template("sample.txt") == "hello {{name}}"


# ── HostState ───────────────────────────────────────────────────────────

def test_state_is_done_and_mark_done():
    st = HostState()
    assert not st.is_done(Phase.OBS_INSTALL)
    st.mark_done(Phase.OBS_INSTALL)
    assert st.is_done(Phase.OBS_INSTALL)


def test_state_mark_done_sets_extra_fields():
    st = HostState()
    st.mark_done(Phase.OBS_WEBSOCKET)
    st.obs_password = "s3cret"
    st.obs_version = "30.0"
    assert st.is_done(Phase.OBS_WEBSOCKET)
    assert st.obs_password == "s3cret"
    assert st.obs_version == "30.0"


def test_state_load_missing_file(monkeypatch, tmp_path):
    monkeypatch.setattr(models, "STATE_FILE", tmp_path / "nope.json")
    st = HostState.load()
    assert st.completed_phases == set()


def test_state_load_valid_json(monkeypatch, tmp_path):
    f = tmp_path / "state.json"
    f.write_text(json.dumps({
        "completed_phases": ["base_packages", "obs_install"],
        "obs_version": "30.2",
        "obs_password": "pw",
        "guac_key": "key",
    }))
    monkeypatch.setattr(models, "STATE_FILE", f)
    st = HostState.load()
    assert st.completed_phases == {Phase.BASE_PACKAGES, Phase.OBS_INSTALL}
    assert st.obs_version == "30.2"
    assert st.obs_password == "pw"
    assert st.guac_key == "key"


def test_state_load_corrupted_json(monkeypatch, tmp_path):
    f = tmp_path / "state.json"
    f.write_text("{ not valid json !!!")
    monkeypatch.setattr(models, "STATE_FILE", f)
    st = HostState.load()
    assert st.completed_phases == set()


def test_state_save_roundtrip(monkeypatch, tmp_path):
    state_dir = tmp_path / "state"
    state_file = state_dir / "host_state.json"
    monkeypatch.setattr(models, "STATE_FILE", state_file)
    monkeypatch.setattr(models, "STATE_DIR", state_dir)

    st = HostState()
    st.mark_done(Phase.BASE_PACKAGES)
    st.obs_password = "pw"
    st.guac_key = "gk"
    st.save()

    assert state_file.exists()
    loaded = HostState.load()
    assert loaded.completed_phases == {Phase.BASE_PACKAGES}
    assert loaded.obs_password == "pw"
    assert loaded.guac_key == "gk"


# ── Result ───────────────────────────────────────────────────────────────────

def test_result_ok():
    r = Result(True, "done")
    assert r.success is True
    assert r.message == "done"


def test_result_fail():
    r = Result(False, "boom")
    assert r.success is False
    assert r.message == "boom"


def test_result_defaults():
    r = Result(True)
    assert r.success is True
    assert r.message == ""
