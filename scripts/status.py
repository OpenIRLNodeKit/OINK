#!/usr/bin/env python3
# SPDX-FileCopyrightText: 2026 OpenIRLNodeKit contributors
# SPDX-License-Identifier: AGPL-3.0-or-later
"""status.py — `oink.py status`: one-shot health report for a host.

Reports, in order:
  1. the systemd units `oink setup` installs (host phase: oink-display/obs/
     vnc/guac + distro guacd; stack phase: oink-nginx/mediamtx/noalbs/api)
  2. the pinned native binaries under ~/oink/stack/bin
  3. the endpoints the stack phase §6 gates on (TCP/UDP port checks)
  4. the HTTP chain (dashboard root, API control plane, preview page)
  5. the stack artifacts under ~/oink/stack that the native units consume

Exit code 0 when everything reported is healthy, 1 otherwise. Read-only.
"""

from __future__ import annotations

import json
import os
import pathlib
import re
import shutil

from logui import C, info, warn
from models import SetupConfig
from process import port_listening, run
from stack import resolve_web_port

# (unit, installed-by) — everything the stack relies on.
UNITS = (
    ("oink-display", "host"),
    ("oink-obs", "host"),
    ("oink-vnc", "host"),
    ("guacd", "host"),  # distro unit from the apt `guacd` package
    ("oink-guac", "host"),
    ("oink-nginx", "stack"),  # distro apt `nginx` binary; unit reads stack nginx.conf
    ("oink-mediamtx", "stack"),
    ("oink-noalbs", "stack"),
    ("oink-api", "stack"),
)

# Pinned binaries the stack phase installs (relative to ~/oink/stack/bin).
# Nginx is deliberately absent: it is distro apt-managed (like guacd).
NATIVE_BINS = ("mediamtx", "noalbs")

# Units that are healthy while off — installed by default but stopped until the
# dashboard toggle starts them. Only their unit file has to exist.
DORMANT_UNITS = {"oink-noalbs"}
_UNIT_DIR = pathlib.Path("/etc/systemd/system")

# Files/dirs the native stack consumes; must exist under ~/oink/stack.
STACK_ARTIFACTS = ("nginx.conf", "ingest.json", "web/build/client", "mediamtx.yml",
                   "noalbs", "noalbs/config.json", "noalbs/.env",
                   "host-info.json", "components.json", "log-server.js")

# TCP/UDP ports gated by the stack phase §6 + the host services (OBS ws, guac
# tunnel). The dashboard port is resolved at runtime (see status_main).
ENDPOINT_PORTS = (("tcp", 1935), ("udp", 8890),
                  ("tcp", 9997), ("tcp", 8082), ("tcp", 4822))
HOST_PORTS = (("tcp", 4455), ("tcp", 8080), ("tcp", 8081))

# Static HTTP probes that exercise the Nginx → log-server → host chain, beyond
# the dashboard + API health URLs built from the resolved web port.
HTTP_REST_PROBES = (
    # The guac client page is served by oink-guac on :8081.
    ("preview page (:8081)", "http://127.0.0.1:8081/"),
)


def _ok_mark(ok: bool) -> str:
    return f"{C['green']}\u2713{C['nc']}" if ok else f"{C['red']}\u2717{C['nc']}"


def _systemd_unit(cfg: SetupConfig, unit: str) -> tuple[bool, bool]:
    r = run(cfg, "systemctl", "is-enabled", unit, capture=True, check=False)
    enabled = r.returncode == 0
    r = run(cfg, "systemctl", "is-active", unit, capture=True, check=False)
    active = r.returncode == 0
    return enabled, active


def _http_probe(cfg: SetupConfig, url: str) -> tuple[str, str]:
    """GET a URL, return (http_code, body). code '000' = connection failure."""
    r = run(cfg, "curl", "-sS", "--max-time", "8", "-o", "-", "-w", "\n%{http_code}", url,
            capture=True, check=False)
    out = (r.stdout or "").split("\n")
    code = out[-1].strip() if out else "000"
    return code, "\n".join(out[:-1])


def status_main(cfg: SetupConfig, as_json: bool = False) -> int:
    checks: list[dict] = []

    def record(group: str, desc: str, ok: bool) -> None:
        checks.append({"group": group, "desc": desc, "ok": ok})

    # ── 1. systemd units ────────────────────────────────────────────────────────
    if not as_json:
        info(cfg, "Systemd units")
    for unit, origin in UNITS:
        enabled, active = _systemd_unit(cfg, unit)
        if unit in DORMANT_UNITS:
            # Off by default (started per session via the dashboard); healthy as
            # long as the unit is installed, whatever its enabled/active state.
            ok = (_UNIT_DIR / f"{unit}.service").exists()
            state = "active" if active else "installed, off by default"
        else:
            ok = enabled and active
            state = ", ".join(x for x in ("enabled" if enabled else "disabled",
                                          "active" if active else "inactive") if x)
        record("systemd", unit, ok)
        if as_json:
            continue
        print(f"  {_ok_mark(ok)} {unit:16} ({state or 'missing'}, {origin})")

    # ── 2. Pinned native binaries ───────────────────────────────────────────────
    if not as_json:
        info(cfg, "Native binaries (~/oink/stack/bin)")
    bin_dir = cfg.stack_dir / "bin"
    for name in NATIVE_BINS:
        present = (bin_dir / name).exists()
        record("binaries", name, present)
        if as_json:
            continue
        print(f"  {_ok_mark(present)} {name}")

    # ── 3. Endpoints (mirrors the stack phase §6) ───────────────────────────────
    web_port = resolve_web_port(cfg)
    if not as_json:
        info(cfg, "Endpoints")

    def check_ports(ports: tuple, suffix: str = "") -> None:
        for proto, port in ports:
            listening = port_listening(port, host="", proto=proto)
            record("endpoint", f"{proto.upper()} :{port}", listening)
            if not as_json:
                print(f"  {_ok_mark(listening)} {proto.upper()}:{port}{suffix}")

    check_ports((("tcp", web_port),) + ENDPOINT_PORTS)
    check_ports(HOST_PORTS, " (host service)")

    # ── 4. HTTP chain (dashboard actually reachable?) ──────────────────────────
    if shutil.which("curl") is None:
        if not as_json:
            warn(cfg, "  curl not installed — HTTP probes skipped")
    else:
        if not as_json:
            info(cfg, "HTTP")
        http_probes = (
            ("dashboard root", f"http://127.0.0.1:{web_port}/"),
            ("api chain (health)", f"http://127.0.0.1:{web_port}/health"),
            *HTTP_REST_PROBES,
        )
        for desc, url in http_probes:
            code, body = _http_probe(cfg, url)
            ok = code.startswith(("2", "3"))
            record("http", f"{desc} [{url}] -> {code}", ok)
            if as_json:
                continue
            extra = ""
            if url.endswith("/") and code == "200":
                m = re.search(r"<title>(.*?)</title>", body, re.I | re.S)
                if m:
                    extra = f" title={m.group(1).strip()[:60]!r}"
            print(f"  {_ok_mark(ok)} {desc} -> HTTP {code}{extra}")

    # ── 5. Stack artifacts ~/oink/stack ──────────────────────────────────────────
    if not as_json:
        info(cfg, "Stack artifacts (~/oink/stack)")
    depl = cfg.stack_dir
    for artifact in STACK_ARTIFACTS:
        present = (depl / artifact).exists()
        record("artifacts", artifact, present)
        if as_json:
            continue
        print(f"  {_ok_mark(present)} {artifact}")

    if as_json:
        print(json.dumps(checks, indent=2))
        return 0 if all(c["ok"] for c in checks) else 1

    ok = all(c["ok"] for c in checks)
    n_ok = sum(1 for c in checks if c["ok"])
    print()
    if ok:
        print(f"{C['green']}All checks passed ({n_ok}/{len(checks)}).{C['nc']}")
    else:
        print(f"{C['red']}{len(checks) - n_ok} problem(s), {n_ok}/{len(checks)} healthy.{C['nc']}")
        if os.geteuid() != 0:
            print("Run as root for full accuracy: `sudo python3 oink.py status`")
        else:
            print("Fix the ✗ items above — on a typical host: `sudo python3 oink.py setup` for the stack,")
            print("or `sudo systemctl restart oink-display oink-obs` for the units.")
    return 0 if ok else 1
