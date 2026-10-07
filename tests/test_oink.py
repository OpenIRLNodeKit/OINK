# SPDX-FileCopyrightText: 2026 OpenIRLNodeKit contributors
# SPDX-License-Identifier: AGPL-3.0-or-later
"""Unit tests for oink.py — the distro minimum-version gate."""

from __future__ import annotations

import pathlib
import subprocess
import sys

import pytest

ROOT = pathlib.Path(__file__).resolve().parent.parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

import oink


@pytest.mark.parametrize("distro_id,version,expected", [
    ("ubuntu", "24.04", True),
    ("ubuntu", "24.04.1", True),
    ("ubuntu", "25.04", True),
    ("ubuntu", "22.04", False),
    ("ubuntu", "20.04", False),
    ("ubuntu", "", False),
    ("ubuntu", "lts", False),
    ("debian", "12", False),
    ("", "24.04", False),
])
def test_distro_supported(distro_id, version, expected):
    assert oink._distro_supported(distro_id, version) is expected


def _env_file(tmp_path, text):
    p = tmp_path / ".env"
    p.write_text(text)
    return p


def test_load_env_file_parses_variants(tmp_path, monkeypatch):
    keys = ("OINK_ADMIN_PASSWORD", "OINK_INGEST_KEY", "OINK_VERIFY_WAIT")
    for k in keys:
        monkeypatch.delenv(k, raising=False)
    path = _env_file(tmp_path, "\n".join([
        "# a comment",
        "",
        "export OINK_ADMIN_PASSWORD=p@ss=word#inline",
        'OINK_INGEST_KEY="quoted value"',
        "OINK_VERIFY_WAIT='single'",
        "not_an_oink_key=nope",
        "export MALFORMED",
    ]))
    try:
        loaded = oink._load_env_file(path)
        assert "OINK_ADMIN_PASSWORD" in loaded
        assert oink.os.environ["OINK_ADMIN_PASSWORD"] == "p@ss=word#inline"
        assert oink.os.environ["OINK_INGEST_KEY"] == "quoted value"
        assert oink.os.environ["OINK_VERIFY_WAIT"] == "single"
        assert "not_an_oink_key" not in oink.os.environ
    finally:
        for k in keys:
            oink.os.environ.pop(k, None)


def test_load_env_file_missing_is_noop(tmp_path, monkeypatch):
    monkeypatch.delenv("OINK_ADMIN_PASSWORD", raising=False)
    assert oink._load_env_file(tmp_path / "absent.env") == []
    assert "OINK_ADMIN_PASSWORD" not in oink.os.environ


def test_load_env_file_ignores_blank_values(tmp_path, monkeypatch):
    keys = ("OINK_ADMIN_PASSWORD", "OINK_INGEST_KEY")
    for k in keys:
        monkeypatch.delenv(k, raising=False)
    path = _env_file(tmp_path, "OINK_ADMIN_PASSWORD=\nOINK_INGEST_KEY=   \n")
    try:
        assert oink._load_env_file(path) == []
        assert "OINK_ADMIN_PASSWORD" not in oink.os.environ
        assert "OINK_INGEST_KEY" not in oink.os.environ
    finally:
        for k in keys:
            oink.os.environ.pop(k, None)


def test_config_flag_missing_file_errors():
    r = subprocess.run(
        [sys.executable, str(ROOT / "oink.py"), "-c", "/nonexistent/oink.conf", "status"],
        capture_output=True, text=True, cwd=str(ROOT), timeout=30,
    )
    assert r.returncode == 2
    assert "config file not found" in r.stderr


def test_load_env_file_real_env_wins(tmp_path, monkeypatch):
    monkeypatch.setenv("OINK_ADMIN_PASSWORD", "from-process")
    path = _env_file(tmp_path, "OINK_ADMIN_PASSWORD=from-file\n")
    loaded = oink._load_env_file(path)
    assert "OINK_ADMIN_PASSWORD" not in loaded
    assert oink.os.environ["OINK_ADMIN_PASSWORD"] == "from-process"


def test_load_env_file_maps_obs_user_alias(tmp_path, monkeypatch):
    monkeypatch.delenv("OINK_OBS_USER", raising=False)
    monkeypatch.delenv("OBS_USER", raising=False)
    path = _env_file(tmp_path, "export OINK_OBS_USER=camuser\n")
    try:
        oink._load_env_file(path)
        assert oink.os.environ["OBS_USER"] == "camuser"
    finally:
        oink.os.environ.pop("OBS_USER", None)


def test_check_oink_key_valid_and_invalid():
    assert oink._check_oink_key("OINK_INGEST_KEY", "MyKnownIngestKey_0123456789") is None
    assert "20+ chars" in oink._check_oink_key("OINK_INGEST_KEY", "too-short")
    assert oink._check_oink_key("OINK_ADMIN_PASSWORD", "12345678") is None
    assert "min 8" in oink._check_oink_key("OINK_ADMIN_PASSWORD", "123")
    assert oink._check_oink_key("OINK_OBS_USER", "annoyinguser") is None
    assert "username" in oink._check_oink_key("OINK_OBS_USER", "3bad")
    assert oink._check_oink_key("OINK_PRIMARY_PLATFORM", "twitch") is None
    assert oink._check_oink_key("OINK_PRIMARY_PLATFORM", "Twich") is not None
    assert oink._check_oink_key("OINK_TWITCH_CHANNEL", "castle_") is None
    assert oink._check_oink_key("OINK_TWITCH_CHANNEL", "bad name") is not None
    assert oink._check_oink_key("OINK_TWITCH_CHANNEL", "a" * 26) is not None
    assert oink._check_oink_key("OINK_VIDEO_PRESET", "1080p60") is None
    assert oink._check_oink_key("OINK_VIDEO_PRESET", "2160p60") is not None
    assert oink._check_oink_key("OINK_TWITCH_BOT_OAUTH", "oauth:abc123") is None
    assert "oauth:" in oink._check_oink_key("OINK_TWITCH_BOT_OAUTH", "abc123")
    assert oink._check_oink_key("OINK_WEB_PORT", "8305") is None
    assert oink._check_oink_key("OINK_WEB_PORT", "9090") is None
    assert oink._check_oink_key("OINK_WEB_PORT", "80") is not None
    assert oink._check_oink_key("OINK_WEB_PORT", "8080") is not None
    assert oink._check_oink_key("OINK_WEB_PORT", "0") is not None
    assert oink._check_oink_key("OINK_WEB_PORT", "70000") is not None
    assert oink._check_oink_key("OINK_WEB_PORT", "abc") is not None
    assert oink._check_oink_key("OINK_LEGACY_DEPRECATED", "x") == "unrecognized key — ignored"



def test_phase_fingerprint_stable_and_sensitive(cfg, monkeypatch):
    """Fingerprint is stable for unchanged templates, changes when one does,
    and is empty for phases with no template inputs."""
    from models import Phase

    assert oink._phase_fingerprint(cfg, Phase.OBS_WEBSOCKET) == ""

    base = oink._phase_fingerprint(cfg, Phase.GUACAMOLE)
    assert base and base == oink._phase_fingerprint(cfg, Phase.GUACAMOLE)

    real = cfg.__class__.template
    monkeypatch.setattr(
        cfg.__class__, "template",
        lambda self, name: "CHANGED" if name == "server.js" else real(self, name),
    )
    assert oink._phase_fingerprint(cfg, Phase.GUACAMOLE) != base


def test_host_state_round_trips_phase_fingerprints(tmp_path, monkeypatch):
    """phase_fingerprints must persist so an upgrade can diff against it."""
    import models
    from models import HostState, Phase

    monkeypatch.setattr(models, "STATE_DIR", tmp_path)
    monkeypatch.setattr(models, "STATE_FILE", tmp_path / "host_state.json")
    HostState(
        completed_phases={Phase.OBS_GOLDEN},
        phase_fingerprints={"obs_golden": "abc123"},
    ).save()

    loaded = HostState.load()
    assert loaded.completed_phases == {Phase.OBS_GOLDEN}
    assert loaded.phase_fingerprints == {"obs_golden": "abc123"}
