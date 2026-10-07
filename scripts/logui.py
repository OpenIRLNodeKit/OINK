# SPDX-FileCopyrightText: 2026 OpenIRLNodeKit contributors
# SPDX-License-Identifier: AGPL-3.0-or-later
"""Logging and prompt helpers (coloured output, stamps, confirm)."""

from __future__ import annotations

import sys
import time
from typing import NoReturn

from models import SetupConfig

# ANSI colours
C = {
    "red": "\033[0;31m",
    "green": "\033[0;32m",
    "yellow": "\033[0;33m",
    "nc": "\033[0m",
}


def _stamp(cfg: SetupConfig) -> str:
    e = int(time.time() - cfg.started_at)
    return f"[{e // 60:02d}:{e % 60:02d}]"

def info(cfg: SetupConfig, msg: str) -> None:
    print(f"{C['green']}[INFO]{C['nc']} {_stamp(cfg)} {msg}")

def warn(cfg: SetupConfig, msg: str) -> None:
    print(f"{C['yellow']}[WARN]{C['nc']} {_stamp(cfg)} {msg}", file=sys.stderr)

def err(cfg: SetupConfig, msg: str) -> None:
    print(f"{C['red']}[ERR]{C['nc']}  {_stamp(cfg)} {msg}", file=sys.stderr)

def bail(cfg: SetupConfig, msg: str, code: int = 1) -> NoReturn:
    err(cfg, msg)
    raise SystemExit(code)

def confirm(cfg: SetupConfig, prompt: str) -> bool:
    """Prompt user for confirmation unless --yes or --dry-run."""
    if cfg.auto_yes:
        info(cfg, f"  → {prompt} [y/N] (auto-yes)")
        return True
    if cfg.dry_run:
        info(cfg, f"  [dry-run] Would prompt: {prompt} [y/N]")
        return False
    try:
        answer = input(f"{prompt} [y/N]: ").strip().lower()
        return answer in ("y", "yes")
    except (EOFError, KeyboardInterrupt):
        return False
