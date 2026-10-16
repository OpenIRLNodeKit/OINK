# SPDX-FileCopyrightText: 2026 OpenIRLNodeKit contributors
# SPDX-License-Identifier: AGPL-3.0-or-later
"""Tests for stack.py env plumbing: dashboard-password gating + ingest seed."""

from __future__ import annotations

import base64
import dataclasses
import hashlib
import pathlib
import shutil
import subprocess

import pytest

import stack


def _cfg_with_api_env(tmp_path, cfg, content):
    (tmp_path / "api.env").write_text(content)
    return dataclasses.replace(cfg, stack_dir=tmp_path)


def _run_capture(calls, key="SeededKey_0123456789abc"):
    def fake(cfg, *args, **kwargs):
        calls.append(list(args))
        return subprocess.CompletedProcess(list(args), 0, stdout=f'{{"key":"{key}"}}\n', stderr="")
    return fake


def test_generated_password_is_shown(cfg, tmp_path):
    c = _cfg_with_api_env(
        tmp_path, cfg,
        "OINK_ADMIN_PASSWORD=abc\nOINK_ADMIN_PASSWORD_ORIGIN=generated\n",
    )
    assert "abc" in stack._dashboard_password_line(c)


def test_provided_password_is_hidden(cfg, tmp_path):
    c = _cfg_with_api_env(
        tmp_path, cfg,
        "OINK_ADMIN_PASSWORD=abc\nOINK_ADMIN_PASSWORD_ORIGIN=provided\n",
    )
    assert stack._dashboard_password_line(c) is None


def test_blank_password_is_hidden(cfg, tmp_path):
    c = _cfg_with_api_env(
        tmp_path, cfg,
        "OINK_ADMIN_PASSWORD=\nOINK_ADMIN_PASSWORD_ORIGIN=generated\n",
    )
    assert stack._dashboard_password_line(c) is None


def test_bootstrap_ingest_passes_env_seed(cfg, monkeypatch):
    monkeypatch.setenv("OINK_INGEST_KEY", "SeededKey_0123456789abc")
    calls = []
    monkeypatch.setattr(stack, "run", _run_capture(calls))
    assert stack._bootstrap_ingest(cfg) == "SeededKey_0123456789abc"
    assert calls[0][0] == "node"
    assert calls[0][-1] == "SeededKey_0123456789abc"


def test_bootstrap_ingest_no_env_seed(cfg, monkeypatch):
    monkeypatch.delenv("OINK_INGEST_KEY", raising=False)
    calls = []
    monkeypatch.setattr(stack, "run", _run_capture(calls, key="GenKey_0123456789abcde"))
    assert stack._bootstrap_ingest(cfg) == "GenKey_0123456789abcde"
    assert calls[0][-1].endswith("mediamtx.yml")


def test_bootstrap_ingest_invalid_seed_warns_and_is_dropped(cfg, monkeypatch):
    monkeypatch.setenv("OINK_INGEST_KEY", "way-too-short")
    calls = []
    monkeypatch.setattr(stack, "run", _run_capture(calls, key="GenKey_0123456789abcde"))
    assert stack._bootstrap_ingest(cfg) == "GenKey_0123456789abcde"
    assert calls[0][-1].endswith("mediamtx.yml")


def test_bootstrap_ingest_dry_run_skips(cfg, monkeypatch):
    monkeypatch.setenv("OINK_INGEST_KEY", "SeededKey_0123456789abc")
    calls = []
    monkeypatch.setattr(stack, "run", _run_capture(calls))
    c = dataclasses.replace(cfg, dry_run=True)
    assert stack._bootstrap_ingest(c) is None
    assert calls == []


def test_render_nginx_subs_web_port(cfg):
    text = stack._render_nginx_cfg(
        pathlib.Path("/srv/web"), pathlib.Path("/srv/tmp"), "obsuser", 8305)
    assert "listen 8305;" in text
    assert "listen 80;" not in text
    assert "__OINK_WEB_PORT__" not in text
    assert str(pathlib.Path("/srv/web")) in text and str(pathlib.Path("/srv/tmp")) in text


def test_render_nginx_proxies_api_ws_with_upgrade(cfg):
    text = stack._render_nginx_cfg(
        pathlib.Path("/srv/web"), pathlib.Path("/srv/tmp"), "obsuser", 8305)
    assert "location = /api/ws {" in text
    assert "proxy_set_header Upgrade $http_upgrade;" in text
    assert 'proxy_set_header Connection "upgrade";' in text


def test_render_nginx_serves_guac_same_origin(cfg):
    # Preview + Remote OBS are proxied on the dashboard origin (no :8081/:8080
    # from the browser), so TLS deployments avoid mixed content.
    text = stack._render_nginx_cfg(
        pathlib.Path("/srv/web"), pathlib.Path("/srv/tmp"), "obsuser", 8305)
    assert "location = /preview-client {" in text
    assert "location = /preview-dashboard {" in text
    assert "location = /guac.js {" in text
    assert "location /remote/ {" in text
    assert "location /guacws/ {" in text
    assert "proxy_pass http://127.0.0.1:8080/;" in text
    assert "frame-src 'self';" in text
    assert "http://*:8081" not in text


def _dashboard_csp(text):
    """The dashboard (SPA) CSP header — unique via its `font-src` directive."""
    return next(line for line in text.splitlines() if "font-src 'self' data:;" in line)


def test_render_nginx_hashes_inline_scripts(cfg, tmp_path):
    # A built SPA with one inline bootstrap script must have its sha256 in the
    # CSP and lose 'unsafe-inline' from script-src.
    body = "\n(function(){var x=1})();\n"
    (tmp_path / "index.html").write_text(
        f"<!DOCTYPE html><html><head><script>{body}</script>"
        '<script type="module" src="/assets/x.js"></script></head></html>')
    expected = "'sha256-" + base64.b64encode(
        hashlib.sha256(body.encode("utf-8")).digest()).decode("ascii") + "'"
    text = stack._render_nginx_cfg(tmp_path, tmp_path, "obsuser", 8305)
    csp = _dashboard_csp(text)
    assert expected in csp
    assert "script-src 'self' " + expected in csp
    assert "'unsafe-inline'" not in csp
    assert "style-src 'self';" in csp
    assert "__CSP_SCRIPT_SRC__" not in text and "__CSP_STYLE_SRC__" not in text


def test_render_nginx_without_index_falls_back(cfg, tmp_path):
    # Missing index.html (dry-run/pre-build) must not emit a broken CSP.
    text = stack._render_nginx_cfg(tmp_path, tmp_path, "obsuser", 8305)
    assert "script-src 'self' 'unsafe-inline'" in _dashboard_csp(text)


def test_web_port_respects_env(cfg, monkeypatch):
    monkeypatch.setenv("OINK_WEB_PORT", "9090")
    assert stack.resolve_web_port(cfg) == 9090


def test_web_port_falls_back_on_invalid(cfg, monkeypatch):
    monkeypatch.setenv("OINK_WEB_PORT", "8080")
    assert stack.resolve_web_port(cfg) == stack.WEB_PORT_DEFAULT


def test_check_trusted_proxies_accepts_true_cidrs_and_disabled():
    assert stack.check_trusted_proxies("") is None
    assert stack.check_trusted_proxies("false") is None
    assert stack.check_trusted_proxies("true") is None
    assert stack.check_trusted_proxies("127.0.0.1/32") is None
    assert stack.check_trusted_proxies("10.0.0.0/8, 192.168.0.0/16") is None


def test_check_trusted_proxies_rejects_garbage():
    assert stack.check_trusted_proxies("not-an-ip") is not None
    assert stack.check_trusted_proxies("10.0.0.0/8,,1.2.3.4") is not None


def test_stack_main_bails_fast_on_invalid_proxies(cfg, monkeypatch):
    # A bad value must never reach the nginx render path.
    monkeypatch.setattr(stack.os, "geteuid", lambda: 0)
    monkeypatch.setenv("OINK_TRUSTED_PROXIES", "10.0.0.0/8,bogus")
    with pytest.raises(SystemExit):
        stack.stack_main(cfg)


def test_render_nginx_disabled_leaves_no_proxy_or_hsts(cfg, monkeypatch):
    monkeypatch.delenv("OINK_TRUSTED_PROXIES", raising=False)
    text = stack._render_nginx_cfg(
        pathlib.Path("/srv/web"), pathlib.Path("/srv/tmp"), "obsuser", 8305)
    assert "__TRUSTED_PROXY_BLOCK__" not in text
    assert "__HSTS_HEADER__" not in text
    assert "set_real_ip_from" not in text
    assert "Strict-Transport-Security" not in text


def test_render_nginx_true_trusts_loopback_and_sets_hsts(cfg, monkeypatch):
    monkeypatch.setenv("OINK_TRUSTED_PROXIES", "true")
    text = stack._render_nginx_cfg(
        pathlib.Path("/srv/web"), pathlib.Path("/srv/tmp"), "obsuser", 8305)
    assert "set_real_ip_from 127.0.0.1;" in text
    assert "set_real_ip_from ::1;" in text
    assert "real_ip_header X-Forwarded-For;" in text
    assert "Strict-Transport-Security" in text


def test_render_nginx_cidr_list_uses_each_network(cfg, monkeypatch):
    monkeypatch.setenv("OINK_TRUSTED_PROXIES", "10.0.0.0/8,192.168.0.0/16")
    text = stack._render_nginx_cfg(
        pathlib.Path("/srv/web"), pathlib.Path("/srv/tmp"), "obsuser", 8305)
    assert "set_real_ip_from 10.0.0.0/8;" in text
    assert "set_real_ip_from 192.168.0.0/16;" in text
    assert "set_real_ip_from 127.0.0.1;" not in text


def test_existing_switcher_values_missing_file(tmp_path):
    assert stack._existing_switcher_values(tmp_path / "nope.json") == {}


def test_existing_switcher_values_malformed_json(tmp_path):
    p = tmp_path / "config.json"
    p.write_text("{not json")
    assert stack._existing_switcher_values(p) == {}


def test_existing_switcher_values_partial_and_bad_types(tmp_path):
    p = tmp_path / "config.json"
    p.write_text('{"switcher": {"triggers": {"low": 500, "offline": "nope"}}}')
    assert stack._existing_switcher_values(p) == {"triggers": {"low": 500}}
    p.write_text('{"switcher": {"bitrateSwitcherEnabled": false, "triggers": {"offline": 150}}}')
    assert stack._existing_switcher_values(p) == {
        "bitrateSwitcherEnabled": False, "triggers": {"offline": 150}}


def test_preserve_user_switcher_overlays_but_keeps_template_keys():
    data = {
        "switcher": {
            "bitrateSwitcherEnabled": True,
            "triggers": {"low": 900, "rtt": 2500, "offline": 300},
            "switchingScenes": {"normal": "main"},
            "streamServers": [{"streamServer": {"statsUrl": "keyed"}}],
        },
        "software": {"password": "pw"},
    }
    saved = {"bitrateSwitcherEnabled": False, "triggers": {"low": 500, "offline": 150}}
    assert stack._preserve_user_switcher(data, saved) is True
    assert data["switcher"]["bitrateSwitcherEnabled"] is False
    assert data["switcher"]["triggers"] == {"low": 500, "rtt": 2500, "offline": 150}
    assert data["switcher"]["streamServers"][0]["streamServer"]["statsUrl"] == "keyed"
    assert data["software"]["password"] == "pw"


def test_preserve_user_switcher_no_saved_is_noop():
    data = {"switcher": {"bitrateSwitcherEnabled": True, "triggers": {"low": 900}}}
    assert stack._preserve_user_switcher(data, {}) is False
    assert data["switcher"]["triggers"] == {"low": 900}


def test_section4b_preserves_dashboard_switcher_across_rerun(cfg, tmp_path, monkeypatch):
    import json

    c = dataclasses.replace(cfg, stack_dir=tmp_path)
    dashboard = tmp_path / "noalbs" / "config.json"
    dashboard.parent.mkdir(parents=True)
    dashboard.write_text(json.dumps({
        "switcher": {
            "bitrateSwitcherEnabled": False,
            "triggers": {"low": 500, "offline": 150},
        }
    }))
    monkeypatch.setattr(stack, "run", _run_capture([], key="SeededKey_0123456789abc"))

    stack.section4b_install_noalbs(c)

    data = json.loads(dashboard.read_text())
    assert data["switcher"]["bitrateSwitcherEnabled"] is False
    assert data["switcher"]["triggers"]["low"] == 500
    assert data["switcher"]["triggers"]["offline"] == 150
    assert data["switcher"]["triggers"]["rtt"] == 2500
    url = data["switcher"]["streamServers"][0]["streamServer"]["statsUrl"]
    assert "live/SeededKey_0123456789abc/irl" in url


def test_section4b_wires_channel_not_bot_into_noalbs(cfg, tmp_path, monkeypatch):
    """NOALBS joins/listens in chat.username (the channel), not the bot login."""
    import json

    c = dataclasses.replace(cfg, stack_dir=tmp_path)
    monkeypatch.setenv("OINK_TWITCH_CHANNEL", "Castle_")
    monkeypatch.setenv("OINK_TWITCH_BOT_USERNAME", "my_bot")
    monkeypatch.setattr(stack, "run", _run_capture([]))

    stack.section4b_install_noalbs(c)

    data = json.loads((tmp_path / "noalbs" / "config.json").read_text())
    assert data["chat"]["username"] == "Castle_"
    # Default command permissions ship as the explicit Admin string.
    assert data["chat"]["commands"]
    assert all(c["permission"] == "Admin" for c in data["chat"]["commands"].values())
    env = (tmp_path / "noalbs" / ".env").read_text()
    assert "TWITCH_BOT_USERNAME=my_bot" in env


def test_dry_run_stack_sections_write_nothing(tmp_path, cfg, monkeypatch, capsys):
    """The native-stack sections must not touch the filesystem under --dry-run:
    every write primitive is trapped while each section runs with dry_run=True."""
    import os
    import shutil

    # Minimal repo fixtures the sections read (created before writes are trapped).
    repo = tmp_path / "repo"
    (repo / "stack/noalbs").mkdir(parents=True)
    (repo / "stack/nginx.conf").write_text("# nginx")
    (repo / "stack/noalbs/config.template").write_text("{}")
    (repo / "stack/noalbs/.env.example").write_text("X=1\n")
    # Data file plugins.js reads from the deployed stack dir — §5 must ship it.
    (repo / "stack/components.json").write_text('{"plugins": []}\n')
    web = repo / "dashboard"
    (web / "node_modules").mkdir(parents=True)
    (web / "package.json").write_text("{}")
    (web / "package-lock.json").write_text("{}")

    c = dataclasses.replace(
        cfg, home=tmp_path, obs_home=tmp_path,
        obs_cfg=tmp_path / "obs-studio",
        obs_ws=tmp_path / "obs-studio/plugin_config/obs-websocket",
        dep_dir=tmp_path / "deps", recording_dir=tmp_path / "recs",
        stack_dir=tmp_path / "installed/stack",
        dry_run=True, auto_yes=True)
    (c.obs_ws).mkdir(parents=True)
    (c.obs_ws / "password").write_text("pw")

    monkeypatch.setattr(stack, "_STACK_DIR", repo / "stack")
    monkeypatch.setattr(stack, "_WEB_DIR", web)

    writes: list[str] = []

    def trap(name):
        def _trap(*_a, **_k):
            writes.append(name)
        return _trap

    for meth in ("write_text", "write_bytes", "mkdir", "touch", "unlink", "symlink_to"):
        monkeypatch.setattr(pathlib.Path, meth, trap(f"Path.{meth}"))
    for mod, meth in ((shutil, "rmtree"), (shutil, "copy2"), (shutil, "copytree"),
                      (os, "chmod"), (os, "replace")):
        monkeypatch.setattr(mod, meth, trap(f"{mod.__name__}.{meth}"))

    monkeypatch.setattr(stack, "run", _run_capture([]))
    monkeypatch.setattr(stack, "run_ok", lambda *a, **k: True)

    stack.section1_prereqs(c)
    stack.section2_build_dashboard(c)
    stack.section3_install_web(c)
    stack.section4_install_ingest(c)
    stack.section4b_install_noalbs(c)
    stack.section5_install_stack(c)

    assert writes == [], f"dry-run wrote: {sorted(set(writes))}"

    # §5 must plan to ship the runtime data files, not just the .js modules:
    # components.json missing from the deployed stack dir silently blinds
    # the dashboard's default-plugin status.
    planned = capsys.readouterr().out
    assert "Would copy" in planned
    assert "components.json" in planned


def test_download_binary_redownloads_when_pin_changes(tmp_path, cfg, monkeypatch):
    """Bumping the pinned sha256 must force a re-download, not a silent skip."""
    bin_dir = tmp_path / "bin"
    bin_dir.mkdir()
    name = "mediamtx"
    (bin_dir / name).write_bytes(b"old-build")
    old_sha = hashlib.sha256(b"old-build").hexdigest()
    (bin_dir / f"{name}.sha256").write_text(old_sha + "\n")

    msgs: list[str] = []
    monkeypatch.setattr(stack, "info", lambda _c, m: msgs.append(m))
    c = dataclasses.replace(cfg, dry_run=True)

    # Pin unchanged -> skip.
    stack._download_binary(c, bin_dir, name,
                           {"version": "1.0", "sha256": old_sha, "url": "u"})
    assert any("skipping download" in m for m in msgs)

    # Pin bumped to a new sha -> must re-download.
    msgs.clear()
    stack._download_binary(c, bin_dir, name,
                           {"version": "2.0", "sha256": "0" * 64, "url": "u"})
    assert any("Would download" in m for m in msgs)


def test_build_srtla_rec_dry_run_plans_without_writing(tmp_path, cfg, monkeypatch):
    msgs: list[str] = []
    monkeypatch.setattr(stack, "info", lambda _c, m: msgs.append(m))
    c = dataclasses.replace(cfg, dry_run=True)
    stack._build_srtla_rec(c, tmp_path)
    assert any("Would build" in m for m in msgs)
    assert not (tmp_path / stack.SRTLA_BIN).exists()


def test_build_srtla_rec_skips_when_commit_matches(tmp_path, cfg, monkeypatch):
    exe = tmp_path / stack.SRTLA_BIN
    exe.write_bytes(b"x")
    (tmp_path / f"{stack.SRTLA_BIN}.version").write_text(stack.SRTLA_COMMIT + "\n")
    calls: list[tuple] = []
    monkeypatch.setattr(stack, "run", lambda *a, **k: calls.append(a))
    msgs: list[str] = []
    monkeypatch.setattr(stack, "info", lambda _c, m: msgs.append(m))
    stack._build_srtla_rec(dataclasses.replace(cfg, auto_yes=True), tmp_path)
    assert calls == []
    assert any("already built" in m for m in msgs)


def test_build_srtla_rec_plans_rebuild_on_different_pin(tmp_path, cfg, monkeypatch):
    exe = tmp_path / stack.SRTLA_BIN
    exe.write_bytes(b"x")
    (tmp_path / f"{stack.SRTLA_BIN}.version").write_text("0123456789ab\n")
    msgs: list[str] = []
    monkeypatch.setattr(stack, "info", lambda _c, m: msgs.append(m))
    c = dataclasses.replace(cfg, dry_run=True)
    stack._build_srtla_rec(c, tmp_path)
    assert any("Would build" in m for m in msgs)


def test_install_executable_replaces_running_binary(tmp_path):
    """Regression: ETXTBSY crash was write_bytes on a live binary (stack.py:626)."""
    prog = tmp_path / "prog"
    shutil.copy2("/bin/sleep", prog)
    p = subprocess.Popen([str(prog), "30"])
    try:
        with pytest.raises(OSError):
            prog.write_bytes(b"junk")
        src = tmp_path / "src"
        src.write_bytes(b"replacement\n")
        stack._install_executable(prog, src)
        assert prog.read_bytes() == b"replacement\n"
        assert prog.stat().st_mode & 0o777 == 0o755
        assert p.poll() is None
        assert not list(tmp_path.glob(".prog.new"))
    finally:
        p.terminate()
