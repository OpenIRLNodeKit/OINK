# SPDX-FileCopyrightText: 2026 OpenIRLNodeKit contributors
# SPDX-License-Identifier: AGPL-3.0-or-later
"""Tests for backup.py: archive round-trip, checksum guard, restore unit handling."""

from __future__ import annotations

import dataclasses
import hashlib
import json
import pathlib
import shutil
import subprocess
import zipfile

import pytest

import backup


def _make_cfg(cfg, tmp_path, **kwargs):
    stack_dir = tmp_path / "stack"
    obs_cfg = tmp_path / "obs-studio"
    stack_dir.mkdir(parents=True, exist_ok=True)
    obs_cfg.mkdir(parents=True, exist_ok=True)
    return dataclasses.replace(
        cfg, stack_dir=stack_dir, obs_cfg=obs_cfg,
        obs_ws=obs_cfg / "plugin_config" / "obs-websocket",
        dep_dir=tmp_path / "deps", recording_dir=tmp_path / "recs", **kwargs)


def _seed(cfg):
    (cfg.stack_dir / "noalbs").mkdir(parents=True, exist_ok=True)
    (cfg.stack_dir / "users.json").write_text('{"users": []}')
    (cfg.stack_dir / "ingest.json").write_text('{"version": 1, "key": "SeededKey_0123456789abc"}')
    (cfg.stack_dir / "api.env").write_text("OINK_SESSION_SECRET=x\n")
    (cfg.stack_dir / "mediamtx.yml").write_text("paths:\n  live/SeededKey_0123456789abc/:\n")
    (cfg.stack_dir / "noalbs" / "config.json").write_text('{"switcher": {}}')
    (cfg.stack_dir / "noalbs" / ".env").write_text("TWITCH_BOT_OAUTH=oauth:x\n")
    (cfg.obs_cfg / "basic" / "scenes").mkdir(parents=True, exist_ok=True)
    (cfg.obs_cfg / "basic" / "scenes" / "oink.json").write_text('{"canvases": []}')
    (cfg.obs_cfg / "global.ini").write_text("[General]\n")

def _append_legacy_member(archive: pathlib.Path, path: str, data: bytes) -> None:
    """Add a member + manifest entry, mimicking archives made before exclusion."""
    with zipfile.ZipFile(archive) as zf:
        items = {n: zf.read(n) for n in zf.namelist()}
    manifest = json.loads(items["manifest.json"])
    manifest["files"].append({
        "path": path,
        "sha256": hashlib.sha256(data).hexdigest(),
        "mode": "0600",
    })
    items[path] = data
    items["manifest.json"] = json.dumps(manifest).encode()
    with zipfile.ZipFile(archive, "w") as zf:
        for name, body in items.items():
            zf.writestr(name, body)


@pytest.fixture
def no_systemctl(monkeypatch):
    calls: list = []
    monkeypatch.setattr(backup, "run", lambda *a, **k: calls.append(a) or _Done())
    monkeypatch.setattr(backup, "run_ok", lambda *a, **k: False)
    return calls


class _Done(subprocess.CompletedProcess):
    def __init__(self):
        super().__init__([], 0, stdout="", stderr="")


def test_round_trip(cfg, tmp_path, no_systemctl, capsys):
    c = _make_cfg(cfg, tmp_path, auto_yes=True)
    _seed(c)
    out = backup.create_backup(c, tmp_path / "b.zip")
    assert out.is_file()

    shutil.rmtree(c.stack_dir)
    shutil.rmtree(c.obs_cfg)
    backup.restore_backup(c, out)

    assert not (c.stack_dir / "users.json").exists(), "accounts must not restore"
    env = (c.stack_dir / "api.env").read_text()
    assert "OINK_SESSION_SECRET=" in env
    assert "OINK_ADMIN_PASSWORD=" in env
    assert "Dashboard login: admin / " in capsys.readouterr().out
    assert json.loads((c.stack_dir / "ingest.json").read_text())["key"] == "SeededKey_0123456789abc"
    assert (c.stack_dir / "mediamtx.yml").exists()
    assert (c.stack_dir / "noalbs" / ".env").read_text().startswith("TWITCH_BOT_OAUTH")
    assert (c.obs_cfg / "basic" / "scenes" / "oink.json").exists()
    assert (c.obs_cfg / "global.ini").exists()

def test_restore_keeps_current_accounts_and_session_secret(cfg, tmp_path, no_systemctl):
    c = _make_cfg(cfg, tmp_path, auto_yes=True)
    _seed(c)
    out = backup.create_backup(c, tmp_path / "b.zip")
    # Credentials change after the backup: restore must not undo that.
    (c.stack_dir / "users.json").write_text('{"users": [{"username": "castle"}]}')
    (c.stack_dir / "api.env").write_text("OINK_SESSION_SECRET=current-secret\n")

    backup.restore_backup(c, out)

    assert "castle" in (c.stack_dir / "users.json").read_text()
    env = (c.stack_dir / "api.env").read_text()
    assert "OINK_SESSION_SECRET=current-secret" in env
    assert "OINK_ADMIN_PASSWORD" not in env

def test_restore_keeps_current_obs_websocket_password(cfg, tmp_path, no_systemctl):
    c = _make_cfg(cfg, tmp_path, auto_yes=True)
    _seed(c)
    # The archive carries the source box's OBS password in the NOALBS config.
    (c.stack_dir / "noalbs" / "config.json").write_text(
        json.dumps({"software": {"password": "source-pw"}, "switcher": {}}))
    out = backup.create_backup(c, tmp_path / "b.zip")

    ws = c.obs_ws / "password"
    ws.parent.mkdir(parents=True, exist_ok=True)
    ws.write_text("current-pw\n")
    backup.restore_backup(c, out)

    data = json.loads((c.stack_dir / "noalbs" / "config.json").read_text())
    assert data["software"]["password"] == "current-pw"

def test_restore_localizes_ingest_urls(cfg, tmp_path, no_systemctl):
    c = _make_cfg(cfg, tmp_path, auto_yes=True)
    _seed(c)
    scene = c.obs_cfg / "basic" / "scenes" / "oink.json"
    scene.write_text(json.dumps({"sources": [
        {"settings": {"url": "srt://192.168.8.248:8890?streamid=read:live/Key/irl&latency=2000000"}},
        {"settings": {"url": "srt://example.com:9000?streamid=read:other"}},
    ]}))
    out = backup.create_backup(c, tmp_path / "b.zip")

    shutil.rmtree(c.obs_cfg)
    backup.restore_backup(c, out)

    data = json.loads(scene.read_text())
    assert data["sources"][0]["settings"]["url"] == (
        "srt://127.0.0.1:8890?streamid=read:live/Key/irl&latency=2000000")
    assert data["sources"][1]["settings"]["url"] == "srt://example.com:9000?streamid=read:other"

def test_legacy_archive_accounts_are_skipped(cfg, tmp_path, no_systemctl):
    c = _make_cfg(cfg, tmp_path, auto_yes=True)
    _seed(c)
    out = backup.create_backup(c, tmp_path / "b.zip")
    _append_legacy_member(out, "stack/users.json", b'{"users": [{"username": "old"}]}')

    backup.restore_backup(c, out)

    assert "castle" not in (c.stack_dir / "users.json").read_text()
    assert (c.stack_dir / "users.json").read_text() == '{"users": []}'


def test_manifest_records_sha256_and_mode(cfg, tmp_path):
    c = _make_cfg(cfg, tmp_path)
    _seed(c)
    out = backup.create_backup(c, tmp_path / "b.zip")
    with zipfile.ZipFile(out) as zf:
        manifest = json.loads(zf.read("manifest.json"))
    paths = {e["path"]: e for e in manifest["files"]}
    assert "stack/users.json" not in paths, "accounts must not be archived"
    assert len(paths["stack/ingest.json"]["sha256"]) == 64
    assert paths["stack/ingest.json"]["mode"].isdigit()


def test_empty_box_bails(cfg, tmp_path):
    c = _make_cfg(cfg, tmp_path)
    with pytest.raises(SystemExit):
        backup.create_backup(c, tmp_path / "b.zip")


def test_missing_sources_skipped(cfg, tmp_path):
    c = _make_cfg(cfg, tmp_path)
    (c.stack_dir / "ingest.json").write_text("{}")
    out = backup.create_backup(c, tmp_path / "b.zip")
    with zipfile.ZipFile(out) as zf:
        manifest = json.loads(zf.read("manifest.json"))
    assert [e["path"] for e in manifest["files"]] == ["stack/ingest.json"]


def test_pre_restore_copies_are_not_backed_up(cfg, tmp_path):
    c = _make_cfg(cfg, tmp_path)
    _seed(c)
    scenes = c.obs_cfg / "basic" / "scenes"
    (scenes / "oink.json.pre-restore-20260101-000000").write_text("{}")
    out = backup.create_backup(c, tmp_path / "b.zip")
    with zipfile.ZipFile(out) as zf:
        names = [e["path"] for e in json.loads(zf.read("manifest.json"))["files"]]
    assert not any(".pre-restore-" in n for n in names)


def test_backup_prints_exclusion_notice(cfg, tmp_path, capsys):
    c = _make_cfg(cfg, tmp_path)
    _seed(c)
    backup.create_backup(c, tmp_path / "b.zip")
    err = capsys.readouterr().err
    assert "not included" in err
    assert str(c.dep_dir) in err
    assert str(c.recording_dir) in err


def test_assets_opt_in_includes_dep_dir(cfg, tmp_path, capsys):
    c = _make_cfg(cfg, tmp_path)
    _seed(c)
    (c.dep_dir / "avatars").mkdir(parents=True, exist_ok=True)
    (c.dep_dir / "avatars" / "a.png").write_bytes(b"png")

    out = backup.create_backup(c, tmp_path / "b.zip", assets=True)

    with zipfile.ZipFile(out) as zf:
        names = [e["path"] for e in json.loads(zf.read("manifest.json"))["files"]]
    assert "assets/avatars/a.png" in names
    err = capsys.readouterr().err
    assert "not included" in err
    assert str(c.dep_dir) not in err          # assets now included
    assert str(c.recording_dir) in err        # recordings still excluded


def _tamper(archive: pathlib.Path, tmp_path: pathlib.Path) -> None:
    extract = tmp_path / "extract"
    with zipfile.ZipFile(archive) as zf:
        zf.extractall(extract)
    (extract / "stack" / "ingest.json").write_text('{"evil": true}')
    with zipfile.ZipFile(archive, "w", zipfile.ZIP_DEFLATED) as zf:
        for p in sorted(extract.rglob("*")):
            if p.is_file():
                zf.write(p, arcname=str(p.relative_to(extract)))


def test_tamper_refused_then_forced(cfg, tmp_path, no_systemctl):
    c = _make_cfg(cfg, tmp_path, auto_yes=True)
    _seed(c)
    out = backup.create_backup(c, tmp_path / "b.zip")
    _tamper(out, tmp_path)
    with pytest.raises(SystemExit):
        backup.restore_backup(c, out)
    backup.restore_backup(c, out, force=True)
    assert "evil" in (c.stack_dir / "ingest.json").read_text()


def test_restore_restarts_only_active_units(cfg, tmp_path, monkeypatch):
    c = _make_cfg(cfg, tmp_path, auto_yes=True)
    _seed(c)
    out = backup.create_backup(c, tmp_path / "b.zip")

    calls: list = []
    monkeypatch.setattr(backup, "run", lambda *a, **k: calls.append(a) or _Done())
    monkeypatch.setattr(backup, "run_ok",
                        lambda cfg_, *a, **k: len(a) > 3 and a[1] == "is-active"
                        and a[3] in ("oink-api", "oink-obs"))
    backup.restore_backup(c, out)

    stopped = [a[3] for a in calls if len(a) > 3 and a[1] == "systemctl" and a[2] == "stop"]
    started = [a[3] for a in calls if len(a) > 3 and a[1] == "systemctl" and a[2] == "start"]
    assert set(stopped) == {"oink-api", "oink-obs"}
    assert set(started) == {"oink-api", "oink-obs"}


def test_restore_maps_assets_and_recordings(cfg, tmp_path, no_systemctl):
    import hashlib

    c = _make_cfg(cfg, tmp_path, auto_yes=True)
    archive = tmp_path / "b.zip"
    payload = {"assets/clip.png": b"png", "recordings/clip.mp4": b"mp4"}
    files = []
    with zipfile.ZipFile(archive, "w", zipfile.ZIP_DEFLATED) as zf:
        for arc, data in payload.items():
            zf.writestr(arc, data)
            files.append({"path": arc, "sha256": hashlib.sha256(data).hexdigest(),
                          "mode": "0644", "size": len(data)})
        backup._add_manifest(zf, {"version": 1, "created_at": "", "hostname": "", "files": files})

    backup.restore_backup(c, archive)
    assert (c.dep_dir / "clip.png").read_bytes() == b"png"
    assert (c.recording_dir / "clip.mp4").read_bytes() == b"mp4"


def test_restore_without_mediamtx_falls_back_to_rerender(cfg, tmp_path, no_systemctl, monkeypatch):
    c = _make_cfg(cfg, tmp_path, auto_yes=True)
    _seed(c)
    (c.stack_dir / "mediamtx.yml").unlink()
    out = backup.create_backup(c, tmp_path / "b.zip")

    called = []
    monkeypatch.setattr(backup.stack, "_bootstrap_ingest", lambda cfg_: called.append(cfg_))
    backup.restore_backup(c, out)
    assert called == [c]


@pytest.mark.skipif(shutil.which("openssl") is None, reason="openssl not installed")
def test_encrypted_round_trip(cfg, tmp_path, monkeypatch):
    import process

    monkeypatch.setenv(backup.PASSPHRASE_ENV, "correct horse battery staple")
    c = _make_cfg(cfg, tmp_path, auto_yes=True)
    _seed(c)

    def fake_run(cfg_, *a, **k):
        if a and a[0] == "openssl":
            return process.run(cfg_, *a, **k)
        return _Done()

    monkeypatch.setattr(backup, "run", fake_run)
    monkeypatch.setattr(backup, "run_ok", lambda *a, **k: False)

    out = backup.create_backup(c, tmp_path / "b.zip", encrypt=True)
    assert out.name.endswith(".enc")
    assert not zipfile.is_zipfile(out)

    shutil.rmtree(c.stack_dir)
    shutil.rmtree(c.obs_cfg)
    backup.restore_backup(c, out)
    assert not (c.stack_dir / "users.json").exists()
    assert (c.stack_dir / "ingest.json").exists()
    assert (c.stack_dir / "api.env").exists()
