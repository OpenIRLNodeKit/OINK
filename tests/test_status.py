# SPDX-FileCopyrightText: 2026 OpenIRLNodeKit contributors
# SPDX-License-Identifier: AGPL-3.0-or-later
"""Tests for status.py: a healthy box (incl. the dormant oink-noalbs) exits 0."""

from __future__ import annotations

import dataclasses

import status


def _fake_unit(normal_ok=True):
    def fake(cfg, unit):
        if unit == "oink-noalbs":
            return (False, False)
        return (True, True) if normal_ok else (False, False)
    return fake


def _prep(tmp_path, cfg, *, noalbs_unit=True):
    """Relocate all of status's filesystem checks under tmp_path."""
    c = dataclasses.replace(cfg, stack_dir=tmp_path / "stack")
    (c.stack_dir / "bin").mkdir(parents=True)
    for b in ("mediamtx", "noalbs"):
        (c.stack_dir / "bin" / b).write_text("x")
    for rel in ("nginx.conf", "ingest.json", "profile.json", "mediamtx.yml",
                "noalbs/config.json", "noalbs/.env", "host-info.json",
                "plugin-defaults.json", "log-server.js"):
        p = c.stack_dir / rel
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text("x")
    (c.stack_dir / "web/build/client").mkdir(parents=True)

    units = tmp_path / "units"
    units.mkdir()
    for unit, _ in status.UNITS:
        if unit == "oink-noalbs" and not noalbs_unit:
            continue
        (units / f"{unit}.service").write_text("x")
    return c, units


def _patch(monkeypatch, units, unit_fn):
    monkeypatch.setattr(status, "_UNIT_DIR", units)
    monkeypatch.setattr(status, "_systemd_unit", unit_fn)
    monkeypatch.setattr(status, "port_listening", lambda *a, **k: True)
    monkeypatch.setattr(status, "_http_probe", lambda *a, **k: ("200", "ok"))


def test_healthy_box_with_dormant_noalbs_exits_zero(tmp_path, cfg, monkeypatch):
    c, units = _prep(tmp_path, cfg)
    _patch(monkeypatch, units, _fake_unit())
    # oink-noalbs is installed but disabled/inactive by design -> still healthy.
    assert status.status_main(c, as_json=True) == 0


def test_missing_dormant_unit_file_is_a_problem(tmp_path, cfg, monkeypatch):
    c, units = _prep(tmp_path, cfg, noalbs_unit=False)
    _patch(monkeypatch, units, _fake_unit())
    assert status.status_main(c, as_json=True) == 1


def test_inactive_required_unit_is_a_problem(tmp_path, cfg, monkeypatch):
    c, units = _prep(tmp_path, cfg)
    _patch(monkeypatch, units, _fake_unit(normal_ok=False))
    assert status.status_main(c, as_json=True) == 1
