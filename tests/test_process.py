# SPDX-FileCopyrightText: 2026 OpenIRLNodeKit contributors
# SPDX-License-Identifier: AGPL-3.0-or-later
"""Unit tests for scripts/process.py — run/run_ok/port_listening helpers."""

from __future__ import annotations

import subprocess

import pytest

from process import apt_get, port_listening, run, run_ok


def _completed(returncode=0, stdout="", stderr=""):
    return subprocess.CompletedProcess(args=[], returncode=returncode,
                                       stdout=stdout, stderr=stderr)


# ── run() ────────────────────────────────────────────────────────────────────

def test_run_calls_subprocess(cfg, monkeypatch):
    captured = {}
    def fake_run(*args, **kwargs):
        captured["args"] = args
        captured["kwargs"] = kwargs
        return _completed(0)
    monkeypatch.setattr(subprocess, "run", fake_run)

    r = run(cfg, "echo", "hi", check=False, capture=True)
    assert captured["args"] == (("echo", "hi"),)  # subprocess.run receives args as first positional
    assert captured["kwargs"]["capture_output"] is True
    assert captured["kwargs"]["check"] is False
    assert r.returncode == 0


def test_run_shell_dry_run_does_not_call_subprocess(cfg, monkeypatch):
    cfg = cfg.__class__(
        **{**cfg.__dict__, "dry_run": True}
    )
    monkeypatch.setattr(subprocess, "run", lambda *a, **k: pytest.fail("should not run"))
    r = run(cfg, "echo hi", shell=True)
    assert r.returncode == 0


def test_run_shell_passes_single_string(cfg, monkeypatch):
    captured = {}
    monkeypatch.setattr(
        subprocess, "run",
        lambda *args, **kwargs: captured.update(args=args, kwargs=kwargs) or _completed(0),
    )
    run(cfg, "echo hi", shell=True, cwd="/tmp")
    assert captured["args"] == ("echo hi",)
    assert captured["kwargs"]["shell"] is True
    assert captured["kwargs"]["cwd"] == "/tmp"


def test_run_check_true_bails_on_nonzero(cfg, monkeypatch):
    def fake_run(*a, **k):
        raise subprocess.CalledProcessError(1, "cmd", stderr="boom")
    monkeypatch.setattr(subprocess, "run", fake_run)
    with pytest.raises(SystemExit) as exc:
        run(cfg, "fail", check=True)
    assert exc.value.code != 0


def test_run_file_not_found_bails(cfg, monkeypatch):
    monkeypatch.setattr(subprocess, "run", lambda *a, **k: (_ for _ in ()).throw(FileNotFoundError()))
    with pytest.raises(SystemExit) as exc:
        run(cfg, "definitely-not-a-cmd")
    assert exc.value.code != 0


def test_run_file_not_found_probe_returns_127(cfg, monkeypatch):
    monkeypatch.setattr(subprocess, "run", lambda *a, **k: (_ for _ in ()).throw(FileNotFoundError()))
    r = run(cfg, "definitely-not-a-cmd", check=False)
    assert r.returncode == 127


def test_run_calledprocess_error_probe_returns_returncode(cfg, monkeypatch):
    def fake_run(*a, **k):
        raise subprocess.CalledProcessError(3, "cmd", stderr="nope")
    monkeypatch.setattr(subprocess, "run", fake_run)
    r = run(cfg, "boom", check=False, capture=True)
    assert r.returncode == 3
    assert r.stderr == "nope"


# ── apt_get() ────────────────────────────────────────────────────────────────

def test_apt_get_quiet_uses_qq_and_capture(cfg, monkeypatch):
    captured = {}
    def fake_run(*args, **kwargs):
        captured["args"] = args
        captured["kwargs"] = kwargs
        return _completed(0)
    monkeypatch.setattr(subprocess, "run", fake_run)

    r = apt_get(cfg, "install", "-y", "nginx")
    cmd_args = captured["args"][0]  # run() forwards args as one positional tuple
    assert cmd_args[0] == "apt-get"
    assert cmd_args[1:] == ("-qq", "install", "-y", "nginx")
    assert captured["kwargs"]["capture_output"] is True
    assert r.returncode == 0


def test_apt_get_verbose_no_qq_no_capture(cfg, monkeypatch):
    cfg = cfg.__class__(**{**cfg.__dict__, "verbose": True})
    captured = {}
    monkeypatch.setattr(
        subprocess, "run",
        lambda *args, **kwargs: captured.update(args=args, kwargs=kwargs) or _completed(0),
    )
    apt_get(cfg, "update")
    assert captured["args"] == (("apt-get", "update"),)
    assert captured["kwargs"].get("capture_output") is False


def test_apt_get_passes_through_extra_kwargs(cfg, monkeypatch):
    captured = {}
    monkeypatch.setattr(
        subprocess, "run",
        lambda *args, **kwargs: captured.update(args=args, kwargs=kwargs) or _completed(0),
    )
    apt_get(cfg, "install", "-y", "nginx", check=True)
    assert captured["kwargs"]["check"] is True


# ── run_ok() ─────────────────────────────────────────────────────────────────

def test_run_ok_true_on_zero(cfg, monkeypatch):
    monkeypatch.setattr(subprocess, "run", lambda *a, **k: _completed(0))
    assert run_ok(cfg, "true") is True


def test_run_ok_false_on_nonzero(cfg, monkeypatch):
    monkeypatch.setattr(subprocess, "run", lambda *a, **k: _completed(1))
    assert run_ok(cfg, "false") is False


def test_run_ok_never_raises_on_exception(cfg, monkeypatch):
    monkeypatch.setattr(subprocess, "run", lambda *a, **k: (_ for _ in ()).throw(OSError()))
    assert run_ok(cfg, "boom") is False


def test_run_ok_propagates_keyboard_interrupt(cfg, monkeypatch):
    monkeypatch.setattr(subprocess, "run", lambda *a, **k: (_ for _ in ()).throw(KeyboardInterrupt()))
    with pytest.raises(KeyboardInterrupt):
        run_ok(cfg, "ctrl-c")


# ── port_listening() ─────────────────────────────────────────────────────────

def _ss_output(lines):
    return "\n".join(lines)


def test_port_listening_found(cfg, monkeypatch):
    monkeypatch.setattr(
        subprocess, "run",
        lambda *a, **k: _completed(0, stdout=_ss_output([
            "LISTEN  0  5  0.0.0.0:8080 0.0.0.0:*",
        ])),
    )
    assert port_listening(8080) is True


def test_port_listening_checks_specific_host(cfg, monkeypatch):
    # host must appear in the line; port must be :PORT
    monkeypatch.setattr(
        subprocess, "run",
        lambda *a, **k: _completed(0, stdout=_ss_output([
            "LISTEN  0  5  127.0.0.1:5900 0.0.0.0:*",
        ])),
    )
    assert port_listening(5900, host="127.0.0.1") is True


def test_port_listening_not_found(cfg, monkeypatch):
    monkeypatch.setattr(
        subprocess, "run",
        lambda *a, **k: _completed(0, stdout=_ss_output([
            "LISTEN  0  5  0.0.0.0:8081 0.0.0.0:*",
        ])),
    )
    assert port_listening(8080) is False


def test_port_listening_host_mismatch(cfg, monkeypatch):
    monkeypatch.setattr(
        subprocess, "run",
        lambda *a, **k: _completed(0, stdout=_ss_output([
            "LISTEN  0  5  0.0.0.0:8080 0.0.0.0:*",
        ])),
    )
    # host "127.0.0.1" not in the 0.0.0.0 line -> False
    assert port_listening(8080, host="127.0.0.1") is False


def test_port_listening_exception_returns_false(cfg, monkeypatch):
    monkeypatch.setattr(subprocess, "run", lambda *a, **k: (_ for _ in ()).throw(RuntimeError()))
    assert port_listening(8080) is False
