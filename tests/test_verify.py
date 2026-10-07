# SPDX-FileCopyrightText: 2026 OpenIRLNodeKit contributors
# SPDX-License-Identifier: AGPL-3.0-or-later
"""Unit tests for scripts/verify.py — post-install health checks (mocked I/O)."""

from __future__ import annotations

import subprocess

import pytest

import verify
from models import HostState
from verify import _sweep_stray_windows
from verify import verify as verify_fn

# Every check (6 base + 5 guac) invokes verify.wait_check once.

BASE_CHECK_COUNT = 6
GUAC_CHECK_COUNT = 5
TOTAL_CHECKS = BASE_CHECK_COUNT + GUAC_CHECK_COUNT


def _wait_stub(results):
    """Return a fake verify.wait_check that pops the next verdict from `results`."""
    calls = []

    def fake_wait_check(cfg, desc, cmd, deadline):
        calls.append((desc, cmd))
        return bool(results.pop(0)) if results else True

    return fake_wait_check, calls


def _patch_env(monkeypatch, wait="100"):
    monkeypatch.setenv("OINK_VERIFY_WAIT", wait)


def test_verify_all_noop(monkeypatch, cfg):
    """All base + guac checks pass -> Result(True); guac checks included."""
    fake_wait, calls = _wait_stub([True] * TOTAL_CHECKS)
    monkeypatch.setattr(verify, "wait_check", fake_wait)
    monkeypatch.setattr(verify.subprocess, "check_output", lambda *a, **k: b"192.168.1.10  other")
    _patch_env(monkeypatch)
    monkeypatch.setattr(verify, "_sweep_stray_windows", lambda c: None)

    res = verify_fn(cfg, HostState())
    assert res.success is True
    assert len(calls) == TOTAL_CHECKS
    cmds = [c[1] for c in calls]
    assert any("guacd" in c for c in cmds)


def test_verify_fails_when_check_fails(monkeypatch, cfg):
    """A failing check -> Result(False); the remaining checks still run."""
    fake_wait, calls = _wait_stub([False] * TOTAL_CHECKS)
    monkeypatch.setattr(verify, "wait_check", fake_wait)
    _patch_env(monkeypatch, wait="0")
    monkeypatch.setattr(verify.time, "sleep", lambda s: None)

    res = verify_fn(cfg, HostState())
    assert res.success is False
    assert len(calls) == TOTAL_CHECKS


def test_verify_bad_hostname_still_ok(monkeypatch, cfg):
    """If hostname -I fails, success path still returns ok (ip falls back to '???')."""
    fake_wait, _calls = _wait_stub([True] * TOTAL_CHECKS)
    monkeypatch.setattr(verify, "wait_check", fake_wait)
    monkeypatch.setattr(verify.subprocess, "check_output", lambda *a, **k: (_ for _ in ()).throw(Exception()))
    _patch_env(monkeypatch)
    monkeypatch.setattr(verify, "_sweep_stray_windows", lambda c: None)
    res = verify_fn(cfg, HostState())
    assert res.success is True


# ── _sweep_stray_windows ─────────────────────────────────────────────────────

class _SubprocessStub:
    def __init__(self, search_stdout=""):
        self.search_stdout = search_stdout
        self.calls = []

    def run(self, cmd, **kwargs):
        self.calls.append(cmd)
        if "windowclose" in cmd:
            return subprocess.CompletedProcess(args=cmd, returncode=0, stdout="", stderr="")
        # search call
        return subprocess.CompletedProcess(
            args=cmd, returncode=0, stdout=self.search_stdout, stderr=""
        )


def test_sweep_stray_windows_returns_early_when_clean(monkeypatch, cfg):
    stub = _SubprocessStub(search_stdout="")  # no stray windows on first round
    monkeypatch.setattr(verify.subprocess, "run", stub.run)
    monkeypatch.setattr(verify.time, "sleep", lambda s: None)
    monkeypatch.setattr(verify, "warn", lambda *a, **kw: pytest.fail("warn should not fire"))
    _sweep_stray_windows(cfg)  # should return without warning
    # one round: windowclose per title + search per title
    search_calls = [c for c in stub.calls if "windowclose" not in c]
    assert len(search_calls) >= 1


def test_sweep_stray_windows_warns_when_persistent(monkeypatch, cfg):
    stub = _SubprocessStub(search_stdout="0x123  Window A\n0xabc  Window B\n")
    monkeypatch.setattr(verify.subprocess, "run", stub.run)
    monkeypatch.setattr(verify.time, "sleep", lambda s: None)
    warned = []
    monkeypatch.setattr(verify, "warn", lambda *a, **kw: warned.append(a))
    _sweep_stray_windows(cfg)
    assert any("Stray windows persist" in "".join(str(x) for x in w) for w in warned)
