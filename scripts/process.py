# SPDX-FileCopyrightText: 2026 OpenIRLNodeKit contributors
# SPDX-License-Identifier: AGPL-3.0-or-later
"""Process helpers: run, run_ok, port_listening, wait helpers."""

from __future__ import annotations

import os
import subprocess
import time

from logui import C, bail
from models import SetupConfig


def run(
    cfg: SetupConfig,
    *args: str,
    check: bool = True,
    capture: bool = False,
    shell: bool = False,
    input: str | None = None,
    cwd: str | None = None,
    env: dict[str, str] | None = None,
) -> subprocess.CompletedProcess:
    """Run a command, respecting --dry-run."""
    if cfg.dry_run:
        print(f"{C['yellow']}[DRY]{C['nc']}   {' '.join(args) if not shell else args[0]}")
        return subprocess.CompletedProcess(args=args if not shell else [args[0]], returncode=0)
    try:
        return subprocess.run(
            args if not shell else args[0],
            check=check,
            capture_output=capture,
            text=True,
            shell=shell,
            input=input,
            cwd=cwd,
            env=env if env is not None else os.environ,
        )
    except FileNotFoundError:
        cmd = args[0] if not shell else args[0].split()[0]
        if check:
            bail(cfg, f"Command not found: {cmd}")
        # Probing (check=False, e.g. version/presence checks) must not abort:
        # a missing binary is reported as exit 127 so run_ok() is False.
        return subprocess.CompletedProcess(
            args=args if not shell else [args[0]], returncode=127
        )
    except subprocess.CalledProcessError as e:
        if not check:
            # Probing never aborts on a non-zero exit; surface it via returncode.
            return subprocess.CompletedProcess(
                args=args if not shell else [args[0]], returncode=e.returncode,
                stdout=e.stdout or "", stderr=e.stderr or "",
            )
        lines = (e.stderr or "").strip().splitlines()
        msg = f"Command failed (exit {e.returncode}): {' '.join(args) if not shell else args[0]}"
        if lines:
            msg += f" — {lines[-1]}"
        bail(cfg, msg)


def apt_get(
    cfg: SetupConfig, *args: str, **kwargs
) -> subprocess.CompletedProcess:
    """Run apt-get — quiet by default, errors still abort.

    Quiet: ``-qq`` + capture, which suppresses dpkg's "Setting up …" lines,
    apt's ``W:`` warnings, and the needrestart banner. ``--verbose`` streams
    everything through unfiltered.
    """
    if cfg.verbose:
        return run(cfg, "apt-get", *args, **kwargs)
    return run(cfg, "apt-get", "-qq", *args, capture=True, **kwargs)


def run_ok(cfg: SetupConfig, *args: str, **kwargs) -> bool:
    """Run a command; return True on success (exit code 0), never raise."""
    try:
        r = run(cfg, *args, check=False, capture=True, **kwargs)
        return r.returncode == 0
    except KeyboardInterrupt:
        raise
    except BaseException:
        return False


def port_listening(port: int, host: str = "0.0.0.0", proto: str = "tcp") -> bool:
    """Check if a TCP/UDP port is in LISTEN state."""
    flags = "-ulnH" if proto == "udp" else "-ltnH"
    try:
        r = subprocess.run(
            ["ss", flags],
            capture_output=True, text=True, check=False,
        )
        for line in r.stdout.splitlines():
            if f":{port} " in line and host in line:
                return True
        return False
    except Exception:
        return False


def wait_port(port: int, timeout: float) -> bool:
    """Poll `port_listening` every 2s until open or `timeout` elapses."""
    deadline = time.time() + timeout
    while not port_listening(port, host=""):
        if time.time() >= deadline:
            return False
        time.sleep(2)
    return True


def node_semver(cfg: SetupConfig) -> tuple[int, int, int] | None:
    """Node.js version as (major, minor, patch), or None if absent/unparsable."""
    r = run(cfg, "node", "--version", capture=True, check=False)
    if r.returncode != 0 or not (r.stdout or "").strip():
        return None
    try:
        parts = r.stdout.lstrip("v").split(".")[:3]
        return (int(parts[0]), int(parts[1]), int(parts[2]))
    except (ValueError, IndexError):
        return None


def wait_check(cfg: SetupConfig, desc: str, cmd: str, deadline: float) -> bool:
    """Poll `cmd` (shell) every 3s until it exits 0 or `deadline` passes.

    Prints the ✓/✗ status line; returns True on success.
    """
    t0 = time.time()
    while True:
        r = run(cfg, cmd, shell=True, capture=True, check=False)
        if r.returncode == 0:
            dt = int(time.time() - t0)
            suffix = f" {C['yellow']}(ready after {dt}s){C['nc']}" if dt >= 6 else ""
            print(f"  {C['green']}\u2713{C['nc']} {desc}{suffix}")
            return True
        if time.time() >= deadline:
            print(f"  {C['red']}\u2717{C['nc']} {desc}")
            return False
        time.sleep(3)
