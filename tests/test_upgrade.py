# SPDX-FileCopyrightText: 2026 OpenIRLNodeKit contributors
# SPDX-License-Identifier: AGPL-3.0-or-later
"""Tests for upgrade.py: GitHub release matching, semver compare, pin rewriting."""

from __future__ import annotations

import json

import pytest

import upgrade


def test_semver_and_is_newer():
    assert upgrade._semver("v1.21.2") == (1, 21, 2)
    assert upgrade._semver("1.0.8") == (1, 0, 8)
    assert upgrade.is_newer("1.20.1", "1.21.2")
    assert not upgrade.is_newer("1.21.2", "1.20.1")
    assert not upgrade.is_newer("1.0.8", "1.0.8")


def test_srtla_rec_is_a_pinned_source_component_not_a_release():
    # srtla_rec lives in components.json "binaries" like mediamtx/noalbs, but
    # kind:"source" — git-built from a pinned commit, no release asset.
    meta = upgrade.DEFAULT_PLUGINS["binaries"]["srtla_rec"]
    assert meta["kind"] == "source"
    assert "commit" in meta
    assert "url" not in meta and "sha256" not in meta


def test_source_built_component_is_informational_not_updatable(monkeypatch):
    # collect() must report a source-built component as current/pinned — no
    # GitHub releases fetch, never an error row — and selection must never
    # offer it for download.
    src = {"repo": "irlserver/srtla",
           "commit": "7fa6985dedd5028b8939e2ac3b32136ca7ad8d4c",
           "version": "7fa6985", "kind": "source"}
    monkeypatch.setattr(
        upgrade, "DEFAULT_PLUGINS",
        {"binaries": {"srtla_rec": src}, "plugins": []})
    calls: list[dict] = []
    monkeypatch.setattr(upgrade, "_fetch_latest", lambda meta: calls.append(meta))
    rows = upgrade.collect()
    row = next(r for r in rows if r["name"] == "srtla_rec")
    assert row["status"] == "current"
    assert row["url"] == "" and row["sha256"] == ""
    assert "pinned source build" in row["detail"]
    assert calls == []  # never hit the GitHub releases API
    assert upgrade.select(rows, auto_yes=True) == []


def test_fetch_latest_matches_asset_and_parses_digest(monkeypatch):
    release = {
        "tag_name": "v1.21.2",
        "assets": [
            {"name": "mediamtx_v1.21.2_linux_arm64.tar.gz",
             "browser_download_url": "u-arm", "digest": "sha256:aa"},
            {"name": "mediamtx_v1.21.2_linux_amd64.tar.gz",
             "browser_download_url": "u-amd", "digest": "sha256:bb"},
        ],
    }
    monkeypatch.setattr(upgrade, "_get_json", lambda url: release)
    meta = {"repo": "bluenviron/mediamtx",
            "asset": r"^mediamtx_.*_linux_amd64\.tar\.gz$"}
    assert upgrade._fetch_latest(meta) == {
        "version": "1.21.2", "url": "u-amd", "sha256": "bb"}


def test_fetch_latest_missing_digest_raises(monkeypatch):
    release = {"tag_name": "v1", "assets": [
        {"name": "a-linux-x64.tar.gz", "browser_download_url": "u", "digest": None}]}
    monkeypatch.setattr(upgrade, "_get_json", lambda url: release)
    with pytest.raises(upgrade.UpgradeError):
        upgrade._fetch_latest({"repo": "r", "asset": r"^a-.*\.tar\.gz$"})


def _manifest(tmp_path):
    doc = {
        "plugins": [{"name": "obs-irl-source", "version": "2.0.0", "url": "old",
                     "sha256": "old", "kind": "tar", "min_obs": [32, 1]}],
        "binaries": {"mediamtx": {"version": "1.20.1", "url": "old",
                                  "sha256": "old", "size": "26"}},
    }
    path = tmp_path / "components.json"
    path.write_text(json.dumps(doc))
    return path


def test_apply_updates_only_selected(tmp_path, monkeypatch):
    path = _manifest(tmp_path)
    monkeypatch.setattr(upgrade, "COMPONENTS_FILE", path)
    upgrade.apply([{"kind": "binary", "name": "mediamtx",
                    "latest": "1.21.2", "url": "new", "sha256": "newsha"}])
    doc = json.loads(path.read_text())
    assert doc["binaries"]["mediamtx"]["version"] == "1.21.2"
    assert doc["binaries"]["mediamtx"]["url"] == "new"
    assert doc["binaries"]["mediamtx"]["size"] == "26"       # non-pin fields kept
    assert doc["plugins"][0]["version"] == "2.0.0"           # unselected untouched


def test_upgrade_main_restores_pins_when_install_fails(tmp_path, monkeypatch, cfg):
    path = _manifest(tmp_path)
    monkeypatch.setattr(upgrade, "COMPONENTS_FILE", path)
    row = {"kind": "binary", "name": "mediamtx", "current": "1.20.1",
           "latest": "1.21.2", "url": "new", "sha256": "newsha",
           "status": "update", "detail": ""}
    monkeypatch.setattr(upgrade, "collect", lambda: [row])
    monkeypatch.setattr(upgrade, "select", lambda rows, auto_yes: rows)
    rc = upgrade.upgrade_main(cfg, check_only=False, auto_yes=True, install=lambda: 1)
    assert rc == 1
    assert json.loads(path.read_text())["binaries"]["mediamtx"]["version"] == "1.20.1"
