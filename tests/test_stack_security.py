# SPDX-FileCopyrightText: 2026 OpenIRLNodeKit contributors
# SPDX-License-Identifier: AGPL-3.0-or-later
"""Tests for the security hardening: fail2ban filter/jail + trusted-proxy bits."""

from __future__ import annotations

import pathlib
import re

import stack

_FILTER = pathlib.Path(__file__).resolve().parent.parent / "scripts/templates/oink-fail2ban-filter.conf"


def _compiled_failregex() -> re.Pattern:
    text = _FILTER.read_text()
    line = next(ln for ln in text.splitlines() if ln.startswith("failregex"))
    pattern = line.split("=", 1)[1].strip().replace("<HOST>", r"(?P<host>\S+)")
    return re.compile(pattern)


def test_failregex_matches_login_401_and_403():
    rx = _compiled_failregex()
    m = rx.search('203.0.113.9 - - [15/Sep/2026:12:00:00 +0000] '
                  '"POST /api/auth/login HTTP/1.1" 401 45 "-" "curl/8"')
    assert m and m.group("host") == "203.0.113.9"
    assert rx.search('203.0.113.9 - - [15/Sep/2026:12:00:00 +0000] '
                     '"POST /api/auth/login HTTP/1.1" 403 0 "-" "curl/8"')


def test_failregex_ignores_success_and_other_paths():
    rx = _compiled_failregex()
    assert not rx.search('203.0.113.9 - - [15/Sep/2026:12:00:00 +0000] '
                         '"POST /api/auth/login HTTP/1.1" 200 12 "-" "curl/8"')
    assert not rx.search('203.0.113.9 - - [15/Sep/2026:12:00:00 +0000] '
                         '"GET /api/assets HTTP/1.1" 401 0 "-" "curl/8"')
    assert not rx.search('203.0.113.9 - - [15/Sep/2026:12:00:00 +0000] '
                         '"POST /api/auth/logout HTTP/1.1" 401 0 "-" "curl/8"')


def test_jail_renders_tmp_port_and_loopback_ignore(cfg, monkeypatch):
    monkeypatch.delenv("OINK_TRUSTED_PROXIES", raising=False)
    monkeypatch.delenv("OINK_WEB_PORT", raising=False)
    text = stack._render_fail2ban_jail(cfg)
    assert "__TMP_DIR__" not in text
    assert "__OINK_WEB_PORT__" not in text
    assert f"port     = {stack.WEB_PORT_DEFAULT}" in text
    assert "logpath  = " in text and "/nginx-tmp/oink-access.log" in text
    assert "ignoreip = 127.0.0.1/8 ::1" in text
    assert "__TRUSTED_PROXY_IGNORE__" not in text


def test_jail_ignores_trusted_proxies_when_configured(cfg, monkeypatch):
    monkeypatch.setenv("OINK_TRUSTED_PROXIES", "10.0.0.0/8,192.168.0.0/16")
    text = stack._render_fail2ban_jail(cfg)
    assert "ignoreip = 127.0.0.1/8 ::1 10.0.0.0/8 192.168.0.0/16" in text


def test_guac_servers_bind_loopback(cfg):
    """The guac tunnel (:8080) and page server (:8081) must bind loopback —
    the browser reaches them through nginx, never directly."""
    src = cfg.template("server.js")
    assert "listen(8081, '127.0.0.1')" in src
    assert "host: '127.0.0.1'," in src
