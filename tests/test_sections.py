# SPDX-FileCopyrightText: 2026 OpenIRLNodeKit contributors
# SPDX-License-Identifier: AGPL-3.0-or-later
"""Unit tests for scripts/sections.py — version parsing & obs-websocket converge."""

from __future__ import annotations

import hashlib
import json
import pathlib
import shutil
import subprocess
import tarfile
import types

import pytest

import obs_profile
import sections
from constants import OBS_WS_PORT
from models import HostState


def _completed(returncode=0, stdout="", stderr=""):
    return subprocess.CompletedProcess(args=[], returncode=returncode,
                                       stdout=stdout, stderr=stderr)


def _run_noop(*args, **kwargs):
    return _completed(0)


def _cfg_with(tmp_path, cfg):
    """Rebuild cfg with obs dirs relocated under tmp_path (real writes allowed)."""
    return cfg.__class__(**{**cfg.__dict__,
                            "obs_cfg": tmp_path / "obs-studio",
                            "obs_ws": tmp_path / "obs-studio/plugin_config/obs-websocket",
                            "global_ini": tmp_path / "obs-studio/global.ini",
                            "user_ini_root": tmp_path / "obs-studio/user.ini",
                            "dry_run": False})


# ── _semver_from_stdout ───────────────────────────────────────────────────────

def test_semver_parses_obs_line():
    assert sections._semver_from_stdout("OBS 30.2.2 (linux)\n") == "30002002"


def test_semver_parses_major_only():
    assert sections._semver_from_stdout("OBS 31.0.0 (linux)\n") == "31000000"


def test_semver_empty_stdout_returns_zero():
    assert sections._semver_from_stdout("") == "0"


def test_semver_unparsable_returns_zero():
    assert sections._semver_from_stdout("no version token here") == "0"


# ── section_obs_websocket (config.json converge) ─────────────────────────────

def _ws_expected(pw):
    return {
        "alerts_enabled": False,
        "auth_required": True,
        "first_load": False,
        "server_enabled": True,
        "server_password": pw,
        "server_port": OBS_WS_PORT,
    }


# ── obs-irl-source helpers (_obs_version_str / _obs_semver_at_least) ─────────

def test_obs_version_str_ppp_banner(tmp_path, cfg, monkeypatch):
    # Ubuntu's PPA prints "OBS Studio - 32.2.0", not "OBS 32.2.0 (linux)".
    monkeypatch.setattr(obs_profile, "run",
                        lambda *a, **k: _completed(0, "OBS Studio - 32.2.0 (linux)\n"))
    c = _cfg_with(tmp_path, cfg)
    assert obs_profile._obs_version_str(c) == "32.2.0"
    assert obs_profile._obs_semver_at_least(c, (32, 1)) is True
    assert obs_profile._obs_semver_at_least(c, (33, 0)) is False


def test_obs_version_str_plain_banner(tmp_path, cfg, monkeypatch):
    monkeypatch.setattr(obs_profile, "run",
                        lambda *a, **k: _completed(0, "OBS 31.0.1 (linux)\n"))
    c = _cfg_with(tmp_path, cfg)
    assert obs_profile._obs_version_str(c) == "31.0.1"
    assert obs_profile._obs_semver_at_least(c, (32, 1)) is False


def test_obs_version_str_empty_returns_blank(tmp_path, cfg, monkeypatch):
    monkeypatch.setattr(obs_profile, "run", lambda *a, **k: _completed(0, ""))
    c = _cfg_with(tmp_path, cfg)
    assert obs_profile._obs_version_str(c) == ""
    assert obs_profile._obs_semver_at_least(c, (32, 1)) is False


def test_obs_websocket_writes_config_when_missing(tmp_path, cfg, monkeypatch):
    monkeypatch.setattr(sections, "run", _run_noop)
    c = _cfg_with(tmp_path, cfg)
    c.obs_ws.mkdir(parents=True)
    (c.obs_ws / "password").write_text("pw123\n")

    st = HostState()
    res = sections.section_obs_websocket(c, st)

    cfg_file = c.obs_ws / "config.json"
    assert cfg_file.exists()
    assert json.loads(cfg_file.read_text()) == _ws_expected("pw123")
    assert res.success
    assert st.obs_password == "pw123"


def test_obs_websocket_converged_config_unchanged(tmp_path, cfg, monkeypatch):
    monkeypatch.setattr(sections, "run", _run_noop)
    c = _cfg_with(tmp_path, cfg)
    c.obs_ws.mkdir(parents=True)
    (c.obs_ws / "password").write_text("pw123\n")
    cfg_file = c.obs_ws / "config.json"
    original = json.dumps(_ws_expected("pw123"), indent=2) + "\n"
    cfg_file.write_text(original)

    sections.section_obs_websocket(c, HostState())

    assert cfg_file.read_text() == original


def test_obs_websocket_restores_stale_and_preserves_extra_key(tmp_path, cfg, monkeypatch):
    monkeypatch.setattr(sections, "run", _run_noop)
    c = _cfg_with(tmp_path, cfg)
    c.obs_ws.mkdir(parents=True)
    (c.obs_ws / "password").write_text("pw123\n")
    cfg_file = c.obs_ws / "config.json"
    stale = _ws_expected("old-password")
    stale["server_port"] = 9999
    stale["runtime_key_from_obs"] = "keep-me"
    cfg_file.write_text(json.dumps(stale, indent=2) + "\n")

    sections.section_obs_websocket(c, HostState())

    parsed = json.loads(cfg_file.read_text())
    assert parsed == {**_ws_expected("pw123"), "runtime_key_from_obs": "keep-me"}


def test_obs_websocket_repairs_corrupt_config(tmp_path, cfg, monkeypatch):
    monkeypatch.setattr(sections, "run", _run_noop)
    c = _cfg_with(tmp_path, cfg)
    c.obs_ws.mkdir(parents=True)
    (c.obs_ws / "password").write_text("pw123\n")
    cfg_file = c.obs_ws / "config.json"
    cfg_file.write_text("{ not valid json !!!")

    sections.section_obs_websocket(c, HostState())

    assert json.loads(cfg_file.read_text()) == _ws_expected("pw123")


# ── section_base_packages (§1) ───────────────────────────────────────────────

def test_section_base_packages_installs_nginx_with_base_pass(tmp_path, cfg, monkeypatch):
    c = cfg.__class__(**{**cfg.__dict__, "dry_run": False})
    installs: list = []
    runs: list = []
    installed = {"done": False}
    node_calls = {"n": 0}

    def _run_ok(*a, **k):
        # run_ok(cfg, "dpkg", ...) — command is a[1]; pre-install probes report
        # "not installed", post-install dpkg checks pass.
        if len(a) > 1 and a[1] == "dpkg" and installed["done"]:
            return True
        return False

    def _node_22_ok(c2):
        node_calls["n"] += 1
        return node_calls["n"] >= 2  # probe False, post-install verify True

    def _apt_get(c2, *args, **kw):
        installs.append(args)
        if args and args[0] == "install":
            installed["done"] = True
        return _completed(0)

    monkeypatch.setattr(sections, "confirm", lambda c2, p: True)
    monkeypatch.setattr(sections, "_node_22_ok", _node_22_ok)
    monkeypatch.setattr(sections, "run_ok", _run_ok)
    monkeypatch.setattr(sections, "apt_get", _apt_get)
    monkeypatch.setattr(sections, "run", lambda *a, **k: runs.append(a) or _completed(0))
    monkeypatch.setattr(sections, "_load_v4l2loopback", lambda c2: None)
    monkeypatch.setattr(sections, "_confirm_dedicated_box", lambda c2: None)
    monkeypatch.setattr(sections, "_disable_unattended_upgrades", lambda c2: None)

    results = sections.section_base_packages(c, HostState())

    assert results.success
    install_calls = [a for a in installs if a and a[0] == "install"]
    assert len(install_calls) == 1
    assert "nginx" in install_calls[0]
    assert "obs-studio" in install_calls[0]
    assert "nodejs" in install_calls[0]
    assert "v4l2loopback-dkms" in install_calls[0]
    assert "v4l2loopback-utils" in install_calls[0]
    assert any(a and a[0] == "update" for a in installs)
    # NodeSource + OBS PPA added before the install pass.
    assert any(len(a) > 1 and a[1] == "add-apt-repository" for a in runs)
    assert any(len(a) > 1 and a[1] == "bash" and a[2] == "-c"
               and "curl -fsSL https://deb.nodesource.com/setup_22.x" in str(a) for a in runs)


def test_section_base_packages_all_installed_skips_apt(tmp_path, cfg, monkeypatch):
    monkeypatch.setattr(sections, "run_ok", lambda *a, **k: True)       # everything present
    monkeypatch.setattr(sections, "_node_22_ok", lambda c2: True)
    monkeypatch.setattr(sections, "apt_get", lambda *a, **k: pytest.fail("apt should not run"))
    monkeypatch.setattr(sections, "_load_v4l2loopback", lambda c2: None)
    monkeypatch.setattr(sections, "_confirm_dedicated_box", lambda c2: None)
    monkeypatch.setattr(sections, "_disable_unattended_upgrades", lambda c2: None)
    c = cfg.__class__(**{**cfg.__dict__, "dry_run": False})

    res = sections.section_base_packages(c, HostState())

    assert res.success


def test_load_v4l2loopback_writes_config_and_modprobes(tmp_path, cfg, monkeypatch):
    c = cfg.__class__(**{**cfg.__dict__, "dry_run": False})
    modload = tmp_path / "modules-load" / "oink-v4l2loopback.conf"
    modprobe_conf = tmp_path / "modprobe.d" / "oink-v4l2loopback.conf"
    monkeypatch.setattr(sections, "_V4L2_MODULE_CONF", modload)
    monkeypatch.setattr(sections, "_V4L2_MODPROBE_CONF", modprobe_conf)
    monkeypatch.setattr(sections, "warn", lambda *a, **k: None)
    monkeypatch.setattr(sections, "_ensure_kernel_modules_extra", lambda c2: None)
    runs: list = []
    monkeypatch.setattr(sections, "run", lambda *a, **k: runs.append(a) or _completed(0))

    sections._load_v4l2loopback(c)

    assert modload.read_text() == "v4l2loopback\n"
    opts = modprobe_conf.read_text()
    assert "exclusive_caps=1" in opts
    assert 'card_label="OBS Virtual Camera"' in opts
    assert any(len(a) > 2 and a[1] == "modprobe" and a[2] == "v4l2loopback" for a in runs)


def test_load_v4l2loopback_dry_run_makes_no_changes(tmp_path, cfg, monkeypatch):
    c = cfg.__class__(**{**cfg.__dict__, "dry_run": True})
    modload = tmp_path / "modules-load" / "oink-v4l2loopback.conf"
    monkeypatch.setattr(sections, "_V4L2_MODULE_CONF", modload)
    monkeypatch.setattr(sections, "run", lambda *a, **k: pytest.fail("dry-run must not run commands"))

    sections._load_v4l2loopback(c)

    assert not modload.exists()


def test_section_obs_user_adds_video_group(cfg, monkeypatch):
    c = cfg.__class__(**{**cfg.__dict__, "dry_run": False})
    monkeypatch.setattr(sections, "run_ok", lambda *a, **k: False)  # user/group absent
    monkeypatch.setattr(sections, "info", lambda *a, **k: None)
    calls: list = []
    monkeypatch.setattr(sections, "run", lambda *a, **k: calls.append(a) or _completed(0))

    res = sections.section_obs_user(c, HostState())

    assert res.success
    assert any(a[1:5] == ("usermod", "-aG", "video", "obsuser") for a in calls)


def test_kernel_modules_extra_installs_when_missing(cfg, monkeypatch):
    c = cfg.__class__(**{**cfg.__dict__, "dry_run": False})
    monkeypatch.setattr(sections.os, "uname",
                        lambda: types.SimpleNamespace(release="6.8.0-45-generic"))
    monkeypatch.setattr(sections, "info", lambda *a, **k: None)
    calls: list = []
    monkeypatch.setattr(sections, "run_ok",
                        lambda *a, **k: calls.append(a) or (a[1] == "apt-get"))

    sections._ensure_kernel_modules_extra(c)

    assert any(a[1:3] == ("apt-get", "install") and "linux-modules-extra-6.8.0-45-generic" in a
               for a in calls)


def test_kernel_modules_extra_skips_when_present(cfg, monkeypatch):
    c = cfg.__class__(**{**cfg.__dict__, "dry_run": False})
    monkeypatch.setattr(sections.os, "uname",
                        lambda: types.SimpleNamespace(release="6.8.0-45-generic"))
    calls: list = []
    monkeypatch.setattr(sections, "run_ok", lambda *a, **k: calls.append(a) or True)

    sections._ensure_kernel_modules_extra(c)

    assert all(a[1:3] != ("apt-get", "install") for a in calls)


# ── _disable_unattended_upgrades ─────────────────────────────────────────────

def _conf_dir(tmp_path) -> pathlib.Path:
    d = tmp_path / "apt.conf.d"
    d.mkdir()
    return d


def test_disable_unattended_upgrades_skips_when_package_missing(tmp_path, cfg, monkeypatch):
    c = cfg.__class__(**{**cfg.__dict__, "dry_run": False})
    monkeypatch.setattr(sections, "_APT_CONF_DIR", _conf_dir(tmp_path))
    monkeypatch.setattr(sections, "run_ok", lambda *a, **k: False)
    called: list = []
    monkeypatch.setattr(sections, "confirm_always", lambda *a, **k: called.append(1) or True)

    sections._disable_unattended_upgrades(c)

    assert not called


def test_disable_unattended_upgrades_skips_when_already_off(tmp_path, cfg, monkeypatch):
    c = cfg.__class__(**{**cfg.__dict__, "dry_run": False})
    d = _conf_dir(tmp_path)
    (d / "20auto-upgrades").write_text('APT::Periodic::Unattended-Upgrade "0";\n')
    monkeypatch.setattr(sections, "_APT_CONF_DIR", d)
    monkeypatch.setattr(sections, "run_ok", lambda *a, **k: True)
    called: list = []
    monkeypatch.setattr(sections, "confirm_always", lambda *a, **k: called.append(1) or True)

    sections._disable_unattended_upgrades(c)

    assert not called


def test_disable_unattended_upgrades_disables_without_prompt(tmp_path, cfg, monkeypatch):
    c = cfg.__class__(**{**cfg.__dict__, "dry_run": False})
    d = _conf_dir(tmp_path)
    conf = d / "20auto-upgrades"
    conf.write_text('APT::Periodic::Unattended-Upgrade "1";\n')
    monkeypatch.setattr(sections, "_APT_CONF_DIR", d)
    monkeypatch.setattr(sections, "_AUTO_UPGRADES_CONF", conf)
    monkeypatch.setattr(sections, "run_ok", lambda *a, **k: True)
    called: list = []
    monkeypatch.setattr(sections, "confirm_always", lambda *a, **k: called.append(1) or True)

    sections._disable_unattended_upgrades(c)

    text = conf.read_text()
    assert 'APT::Periodic::Update-Package-Lists "0";' in text
    assert 'APT::Periodic::Unattended-Upgrade "0";' in text
    assert not called


def test_disable_unattended_upgrades_dry_run_writes_nothing(tmp_path, cfg, monkeypatch):
    c = cfg.__class__(**{**cfg.__dict__, "dry_run": True})
    d = _conf_dir(tmp_path)
    conf = d / "20auto-upgrades"
    conf.write_text('APT::Periodic::Unattended-Upgrade "1";\n')
    monkeypatch.setattr(sections, "_APT_CONF_DIR", d)
    monkeypatch.setattr(sections, "_AUTO_UPGRADES_CONF", conf)

    sections._disable_unattended_upgrades(c)

    assert conf.read_text() == 'APT::Periodic::Unattended-Upgrade "1";\n'


# ── _confirm_dedicated_box ───────────────────────────────────────────────────

def test_confirm_dedicated_box_refusal_aborts(cfg, monkeypatch):
    c = cfg.__class__(**{**cfg.__dict__, "dry_run": False, "auto_yes": True, "force": False})
    monkeypatch.setattr("builtins.input", lambda _: "n")

    with pytest.raises(SystemExit):
        sections._confirm_dedicated_box(c)


def test_confirm_dedicated_box_auto_yes_still_prompts(cfg, monkeypatch):
    c = cfg.__class__(**{**cfg.__dict__, "dry_run": False, "auto_yes": True, "force": False})
    prompts: list = []
    monkeypatch.setattr("builtins.input", lambda _: prompts.append(1) or "y")

    sections._confirm_dedicated_box(c)

    assert prompts  # -y must not bypass the consent prompt


def test_confirm_dedicated_box_force_skips_prompt(cfg, monkeypatch):
    c = cfg.__class__(**{**cfg.__dict__, "dry_run": False, "auto_yes": True, "force": True})
    monkeypatch.setattr("builtins.input", lambda _: pytest.fail("force must not prompt"))

    sections._confirm_dedicated_box(c)


def test_confirm_dedicated_box_dry_run_never_bails(cfg, monkeypatch):
    c = cfg.__class__(**{**cfg.__dict__, "dry_run": True})
    monkeypatch.setattr("builtins.input", lambda _: pytest.fail("dry-run must not prompt"))

    sections._confirm_dedicated_box(c)


# ── section_obs_irl_source + section_aitum_plugins (default plugin installs) ──

def _make_fixture_tar(path: pathlib.Path) -> pathlib.Path:
    """Build a small tarball mimicking the obs-irl-source release layout."""
    tar_path = path / "obs-irl-source-fixture.tar.gz"
    root = f"obs-irl-source-{sections.IRL_SOURCE['version']}-linux-x64"
    with tarfile.open(tar_path, "w:gz") as tar:
        so = root + "/bin/64bit/obs-irl-source.so"
        ini = root + "/data/locale/en-US.ini"
        _add_tar(tar, so, b"\x7fELF fake plugin binary")
        _add_tar(tar, ini, b'URL="URL"\n')
    return tar_path


def _add_tar(tar: tarfile.TarFile, name: str, data: bytes) -> None:
    info = tarfile.TarInfo(name)
    info.size = len(data)
    tar.addfile(info, __import__("io").BytesIO(data))


def _install_run_with_fixture(fixture: pathlib.Path):
    """A run() stand-in that performs the real curl/tar/mkdir/cp/rm steps against a
    local fixture tarball (no network), fakes `obs --version`, and no-ops the
    rest (chown/systemctl)."""

    def _smart_run(*args, **kwargs):
        argv = list(args[1:])
        cmd = str(args[1]) if len(args) > 1 else ""
        if cmd == "curl":
            dest = argv[argv.index("-o") + 1] if "-o" in argv else None
            if dest:
                shutil.copyfile(fixture, dest)
            return _completed(0)
        if cmd == "obs":
            return _completed(0, "OBS 32.2.0 (linux)\n")
        if cmd in ("tar", "mkdir", "cp", "rm"):
            r = subprocess.run(argv, check=False, capture_output=True, text=True)
            return subprocess.CompletedProcess(args=argv, returncode=r.returncode,
                                               stdout=r.stdout, stderr=r.stderr)
        return _completed(0)

    return _smart_run


def _install_run_with_deb(fixture: pathlib.Path):
    """A run() stand-in for the §4d Aitum flow: curl stages the fixture deb and
    `dpkg-deb -x` materializes the deb's usr/lib + usr/share layout in staging."""

    def _smart_run(*args, **kwargs):
        argv = list(args[1:])
        cmd = str(args[1]) if len(args) > 1 else ""
        if cmd == "curl":
            dest = argv[argv.index("-o") + 1] if "-o" in argv else None
            if dest:
                shutil.copyfile(fixture, dest)
            return _completed(0)
        if cmd == "obs":
            return _completed(0, "OBS 32.2.0 (linux)\n")
        if cmd == "dpkg-deb":
            staging = pathlib.Path(argv[argv.index("-x") + 2])
            # tmp is /tmp/oink-<name>-<version>.deb -> name = its middle segment(s).
            tmp_name = pathlib.Path(argv[argv.index("-x") + 1]).name
            name = "-".join(tmp_name.split("-")[1:-1])
            (staging / "usr/lib/x86_64-linux-gnu/obs-plugins").mkdir(parents=True)
            (staging / "usr/lib/x86_64-linux-gnu/obs-plugins" / f"{name}.so").write_bytes(
                b"\x7fELF fake plugin binary"
            )
            share = staging / "usr/share/obs/obs-plugins" / name / "locale"
            share.mkdir(parents=True)
            (share / "en-US.ini").write_text('URL="URL"\n')
            return _completed(0)
        if cmd in ("tar", "mkdir", "cp", "rm"):
            r = subprocess.run(argv, check=False, capture_output=True, text=True)
            return subprocess.CompletedProcess(args=argv, returncode=r.returncode,
                                               stdout=r.stdout, stderr=r.stderr)
        return _completed(0)

    return _smart_run


def _obs_cfg_plugins(cfg) -> pathlib.Path:
    return cfg.obs_cfg / "plugins" / "obs-irl-source"


def _aitum_so(cfg, name):
    return cfg.obs_cfg / "plugins" / name / "bin" / "64bit" / f"{name}.so"


def _with_irl_sha(monkeypatch, digest):
    monkeypatch.setattr(sections, "IRL_SOURCE", {**sections.IRL_SOURCE, "sha256": digest})


def _with_aitum_sha(monkeypatch, digest):
    monkeypatch.setattr(sections, "AITUM_PLUGINS", [
        {**p, "sha256": digest} for p in sections.AITUM_PLUGINS
    ])


def test_irl_source_skips_when_already_present(tmp_path, cfg, monkeypatch):
    calls: list = []
    c = _cfg_with(tmp_path, cfg)
    plugin = _obs_cfg_plugins(c)
    (plugin / "bin" / "64bit").mkdir(parents=True)
    (plugin / "bin" / "64bit" / "obs-irl-source.so").write_bytes(b"\x7fELF")
    (plugin / obs_profile.PLUGIN_VERSION_MARKER).write_text(sections.IRL_SOURCE["version"])
    # Inactive unit -> no restart.
    monkeypatch.setattr(sections, "run_ok", lambda *a, **k: False)

    def _record_run(*args, **kwargs):
        calls.append(args)
        return _completed(0)

    monkeypatch.setattr(sections, "run", _record_run)
    res = sections.section_obs_irl_source(c, HostState())

    assert res.success
    assert not any(a[1:] and a[1] == "curl" for a in calls)


def test_irl_source_reinstalls_on_version_bump(tmp_path, cfg, monkeypatch):
    """A pinned-version change must replace the installed plugin, not skip it."""
    calls: list = []
    fixture = _make_fixture_tar(tmp_path)
    digest = hashlib.sha256(fixture.read_bytes()).hexdigest()
    _with_irl_sha(monkeypatch, digest)
    c = _cfg_with(tmp_path, cfg)
    plugin = _obs_cfg_plugins(c)
    (plugin / "bin" / "64bit").mkdir(parents=True)
    (plugin / "bin" / "64bit" / "obs-irl-source.so").write_bytes(b"\x7fELF stale")
    (plugin / obs_profile.PLUGIN_VERSION_MARKER).write_text("0.0.0-old")

    smart = _install_run_with_fixture(fixture)

    def _record_run(*args, **kwargs):
        calls.append(args)
        return smart(*args, **kwargs)

    monkeypatch.setattr(sections, "run", _record_run)
    monkeypatch.setattr(obs_profile, "run", _record_run)
    res = sections.section_obs_irl_source(c, HostState())

    assert res.success
    assert any(a[1:] and a[1] == "curl" for a in calls), "expected a re-download"
    assert (plugin / obs_profile.PLUGIN_VERSION_MARKER).read_text().strip() == sections.IRL_SOURCE["version"]


def test_irl_source_fails_when_obs_too_old(tmp_path, cfg, monkeypatch):
    monkeypatch.setattr(sections, "_obs_semver_at_least", lambda c, m: False)
    monkeypatch.setattr(sections, "run", _run_noop)
    c = _cfg_with(tmp_path, cfg)

    with pytest.raises(SystemExit):
        sections.section_obs_irl_source(c, HostState())

    assert not _obs_cfg_plugins(c).exists()


def test_irl_source_checksum_mismatch_fails(tmp_path, cfg, monkeypatch):
    fixture = _make_fixture_tar(tmp_path)
    _with_irl_sha(monkeypatch, "0" * 64)
    smart = _install_run_with_fixture(fixture)
    # The plugin section (sections.py) and the shared OBS version helper
    # (obs_profile.py) each resolve `run` in their own module namespace.
    monkeypatch.setattr(sections, "run", smart)
    monkeypatch.setattr(obs_profile, "run", smart)
    c = _cfg_with(tmp_path, cfg)

    with pytest.raises(SystemExit):
        sections.section_obs_irl_source(c, HostState())

    assert not _obs_cfg_plugins(c).exists()
    assert not (pathlib.Path("/tmp") / f"oink-irl-source-{sections.IRL_SOURCE['version']}").exists()


def test_irl_source_installs_from_tarball(tmp_path, cfg, monkeypatch):
    fixture = _make_fixture_tar(tmp_path)
    digest = hashlib.sha256(fixture.read_bytes()).hexdigest()
    _with_irl_sha(monkeypatch, digest)
    smart = _install_run_with_fixture(fixture)
    monkeypatch.setattr(sections, "run", smart)
    monkeypatch.setattr(obs_profile, "run", smart)
    c = _cfg_with(tmp_path, cfg)

    res = sections.section_obs_irl_source(c, HostState())

    assert res.success
    so = _obs_cfg_plugins(c) / "bin" / "64bit" / "obs-irl-source.so"
    assert so.exists()
    # tmp + staging cleaned up after a successful install.
    assert not (pathlib.Path("/tmp") / f"oink-irl-source-{sections.IRL_SOURCE['version']}").exists()


# ── section_aitum_plugins (§4d) ──────────────────────────────────────────────

def test_aitum_plugins_skips_when_already_present(tmp_path, cfg, monkeypatch):
    calls: list = []
    c = _cfg_with(tmp_path, cfg)
    for meta in sections.AITUM_PLUGINS:
        (c.obs_cfg / "plugins" / meta["name"] / "bin" / "64bit").mkdir(parents=True)
        (c.obs_cfg / "plugins" / meta["name"] / "bin" / "64bit" / f"{meta['name']}.so").write_bytes(b"\x7fELF")
        (c.obs_cfg / "plugins" / meta["name"] / obs_profile.PLUGIN_VERSION_MARKER).write_text(meta["version"])
    monkeypatch.setattr(sections, "run_ok", lambda *a, **k: False)

    def _record_run(*args, **kwargs):
        calls.append(args)
        return _completed(0)

    monkeypatch.setattr(sections, "run", _record_run)
    res = sections.section_aitum_plugins(c, HostState())

    assert res.success
    assert not any(a[1:] and a[1] == "curl" for a in calls)


def test_aitum_plugins_reinstalls_on_version_bump(tmp_path, cfg, monkeypatch):
    """A pinned-version change must replace the installed plugin, not skip it."""
    calls: list = []
    fixture = tmp_path / "fake.deb"
    fixture.write_bytes(b"deb-bytes")
    digest = hashlib.sha256(fixture.read_bytes()).hexdigest()
    _with_aitum_sha(monkeypatch, digest)
    c = _cfg_with(tmp_path, cfg)
    for meta in sections.AITUM_PLUGINS:
        (c.obs_cfg / "plugins" / meta["name"] / "bin" / "64bit").mkdir(parents=True)
        (c.obs_cfg / "plugins" / meta["name"] / "bin" / "64bit" / f"{meta['name']}.so").write_bytes(b"\x7fELF stale")
        (c.obs_cfg / "plugins" / meta["name"] / obs_profile.PLUGIN_VERSION_MARKER).write_text("0.0.0-old")

    smart = _install_run_with_deb(fixture)

    def _record_run(*args, **kwargs):
        calls.append(args)
        return smart(*args, **kwargs)

    monkeypatch.setattr(sections, "run", _record_run)
    monkeypatch.setattr(obs_profile, "run", _record_run)
    res = sections.section_aitum_plugins(c, HostState())

    assert res.success
    assert any(a[1:] and a[1] == "curl" for a in calls), "expected a re-download"
    for meta in sections.AITUM_PLUGINS:
        marker = c.obs_cfg / "plugins" / meta["name"] / obs_profile.PLUGIN_VERSION_MARKER
        assert marker.read_text().strip() == meta["version"]


def test_aitum_plugins_skips_when_obs_too_old(tmp_path, cfg, monkeypatch):
    monkeypatch.setattr(sections, "_obs_semver_at_least", lambda c, m: False)
    monkeypatch.setattr(sections, "run", _run_noop)
    c = _cfg_with(tmp_path, cfg)

    res = sections.section_aitum_plugins(c, HostState())

    assert res.success
    assert not (c.obs_cfg / "plugins").exists()


def test_aitum_plugins_checksum_mismatch_fails(tmp_path, cfg, monkeypatch):
    fixture = tmp_path / "fake.deb"
    fixture.write_bytes(b"deb-bytes")
    _with_aitum_sha(monkeypatch, "0" * 64)
    smart = _install_run_with_deb(fixture)
    monkeypatch.setattr(sections, "run", smart)
    monkeypatch.setattr(obs_profile, "run", smart)
    c = _cfg_with(tmp_path, cfg)

    with pytest.raises(SystemExit):
        sections.section_aitum_plugins(c, HostState())

    assert not (c.obs_cfg / "plugins").exists()


def test_aitum_plugins_installs_from_deb(tmp_path, cfg, monkeypatch):
    fixture = tmp_path / "fake.deb"
    fixture.write_bytes(b"deb-bytes")
    digest = hashlib.sha256(fixture.read_bytes()).hexdigest()
    _with_aitum_sha(monkeypatch, digest)
    smart = _install_run_with_deb(fixture)
    monkeypatch.setattr(sections, "run", smart)
    monkeypatch.setattr(obs_profile, "run", smart)
    c = _cfg_with(tmp_path, cfg)

    res = sections.section_aitum_plugins(c, HostState())

    assert res.success
    for meta in sections.AITUM_PLUGINS:
        name = meta["name"]
        so = _aitum_so(c, name)
        assert so.exists(), f"{name} .so missing"
        data_ini = c.obs_cfg / "plugins" / name / "data" / "locale" / "en-US.ini"
        assert data_ini.exists(), f"{name} data tree missing"
        assert not (pathlib.Path("/tmp") / f"oink-{name}-{meta['version']}.deb").exists()
        assert not (pathlib.Path("/tmp") / f"oink-{name}-extract-{meta['version']}").exists()


# ── section_obs_vertical (§6c) ───────────────────────────────────────────────

def _vertical_plugin_present(c, name="vertical-canvas"):
    d = c.obs_cfg / "plugins" / name / "bin" / "64bit"
    d.mkdir(parents=True)
    (d / f"{name}.so").write_bytes(b"\x7fELF")


def test_obs_vertical_skips_when_plugin_missing(tmp_path, cfg, monkeypatch):
    monkeypatch.setattr(obs_profile, "_obs_semver_at_least", lambda c, m: True)
    monkeypatch.setattr(obs_profile, "run", _run_noop)
    c = _cfg_with(tmp_path, cfg)

    res = obs_profile.section_obs_vertical(c, HostState())

    assert res.success
    assert "plugin missing" in res.message
    assert not (c.obs_cfg / "basic" / "scenes" / "oink.json").exists()


def test_obs_vertical_skips_when_obs_too_old(tmp_path, cfg, monkeypatch):
    c = _cfg_with(tmp_path, cfg)
    _vertical_plugin_present(c)
    monkeypatch.setattr(obs_profile, "_obs_semver_at_least", lambda c, m: False)
    monkeypatch.setattr(obs_profile, "run", _run_noop)

    res = obs_profile.section_obs_vertical(c, HostState())

    assert res.success
    assert "OBS too old" in res.message
    assert not (c.obs_cfg / "basic" / "scenes" / "oink.json").exists()


def test_obs_vertical_dry_run_skips_write(tmp_path, cfg, monkeypatch):
    c = _cfg_with(tmp_path, cfg)
    _vertical_plugin_present(c)
    c = c.__class__(**{**c.__dict__, "dry_run": True})
    monkeypatch.setattr(obs_profile, "_obs_semver_at_least", lambda c, m: True)
    monkeypatch.setattr(obs_profile, "run", _run_noop)

    res = obs_profile.section_obs_vertical(c, HostState())

    assert res.success
    assert not (c.obs_cfg / "basic" / "scenes" / "oink.json").exists()


def test_obs_vertical_writes_template_and_restarts(tmp_path, cfg, monkeypatch):
    c = _cfg_with(tmp_path, cfg)
    _vertical_plugin_present(c)
    monkeypatch.setattr(obs_profile, "_obs_semver_at_least", lambda c, m: True)
    monkeypatch.setattr(obs_profile, "_vertical_canvas_live", lambda c: True)
    # obs-websocket port "listening" immediately; oink-obs active -> stop/start.
    monkeypatch.setattr(obs_profile, "wait_port", lambda *a, **k: True)
    monkeypatch.setattr(obs_profile, "run_ok", lambda *a, **k: True)
    monkeypatch.setattr(obs_profile, "run", _run_noop)

    res = obs_profile.section_obs_vertical(c, HostState())

    assert res.success
    collection = c.obs_cfg / "basic" / "scenes" / "oink.json"
    assert collection.exists()
    data = json.loads(collection.read_text())
    assert any(canv.get("info", {}).get("name") == "Aitum Vertical"
               for canv in data.get("canvases", []))
    # Current profile + collection recorded as oink in the top-level user.ini.
    assert _ini_kv(c)["Profile"] == "oink"
    assert _ini_kv(c)["SceneCollection"] == "oink"
    # Untitled profile dir + collection file removed (were never created here).
    assert not (c.obs_cfg / "basic" / "profiles" / "Untitled").exists()
    assert not (c.obs_cfg / "basic" / "scenes" / "Untitled.json").exists()


def _ini_kv(c):
    """Read the [Basic] block of the test cfg's top-level user.ini as a dict."""
    lines = c.user_ini_root.read_text().splitlines()
    kv = {}
    in_target = False
    for line in lines:
        s = line.strip()
        if s.startswith("["):
            in_target = s == "[Basic]"
            continue
        if in_target and "=" in s:
            k, v = s.split("=", 1)
            kv[k.strip()] = v.strip()
    return kv


def test_obs_vertical_idempotent_skips_rewrite(tmp_path, cfg, monkeypatch):
    c = _cfg_with(tmp_path, cfg)
    _vertical_plugin_present(c)
    monkeypatch.setattr(obs_profile, "_obs_semver_at_least", lambda c, m: True)
    monkeypatch.setattr(obs_profile, "run_ok", lambda *a, **k: False)  # OBS inactive
    monkeypatch.setattr(obs_profile, "run", _run_noop)

    # First run writes the template + records oink as the default.
    monkeypatch.setattr(obs_profile, "wait_port", lambda *a, **k: True)
    monkeypatch.setattr(obs_profile, "_vertical_canvas_live", lambda c: True)
    obs_profile.section_obs_vertical(c, HostState())
    collection = c.obs_cfg / "basic" / "scenes" / "oink.json"
    assert collection.exists()
    first = collection.read_text()

    # Second run sees oink already the default -> does not rewrite.
    monkeypatch.setattr(obs_profile, "_vertical_canvas_live", lambda c: True)
    res = obs_profile.section_obs_vertical(c, HostState())

    assert res.success
    assert collection.read_text() == first
    assert _ini_kv(c)["Profile"] == "oink"


def test_obs_vertical_degrades_on_canvas_not_live(tmp_path, cfg, monkeypatch):
    c = _cfg_with(tmp_path, cfg)
    _vertical_plugin_present(c)
    monkeypatch.setattr(obs_profile, "_obs_semver_at_least", lambda c, m: True)
    monkeypatch.setattr(obs_profile, "wait_port", lambda *a, **k: True)
    monkeypatch.setattr(obs_profile, "_vertical_canvas_live", lambda c: False)
    monkeypatch.setattr(obs_profile, "run_ok", lambda *a, **k: False)
    monkeypatch.setattr(obs_profile, "run", _run_noop)

    res = obs_profile.section_obs_vertical(c, HostState())

    assert res.success
    assert "degraded" in res.message


# ── oink-default helpers (_user_ini_merge / _oink_default_configured / _remove_untitled) ─

def test_set_oink_default_replaces_keys_and_preserves_other_sections(tmp_path, cfg, monkeypatch):
    monkeypatch.setattr(obs_profile, "run", _run_noop)
    c = _cfg_with(tmp_path, cfg)
    c.user_ini_root.parent.mkdir(parents=True, exist_ok=True)
    c.user_ini_root.write_text(
        "[Basic]\nProfile=Untitled\nSceneCollection=Untitled\n\n[Aitum]\nThemeSet=true\n")
    obs_profile._set_oink_default(c)
    text = c.user_ini_root.read_text()
    kv = _ini_kv(c)
    assert kv["Profile"] == "oink"
    assert kv["SceneCollection"] == "oink"
    assert kv["SceneCollectionFile"] == "oink.json"  # missing key added
    assert "ThemeSet = true" in text                  # unrelated section preserved
    assert "Profile = Untitled" not in text


def test_set_oink_default_adds_section_when_absent(tmp_path, cfg, monkeypatch):
    monkeypatch.setattr(obs_profile, "run", _run_noop)
    c = _cfg_with(tmp_path, cfg)
    c.user_ini_root.parent.mkdir(parents=True, exist_ok=True)
    c.user_ini_root.write_text("[General]\nLastVersion=30\n")
    obs_profile._set_oink_default(c)
    assert _ini_kv(c)["Profile"] == "oink"
    assert "[General]" in c.user_ini_root.read_text()


def test_set_oink_default_leaves_same_key_in_other_section(tmp_path, cfg, monkeypatch):
    monkeypatch.setattr(obs_profile, "run", _run_noop)
    c = _cfg_with(tmp_path, cfg)
    c.user_ini_root.parent.mkdir(parents=True, exist_ok=True)
    c.user_ini_root.write_text("[Foo]\nProfile=Untitled\n\n[Basic]\n")
    obs_profile._set_oink_default(c)
    text = c.user_ini_root.read_text()
    assert _ini_kv(c)["Profile"] == "oink"
    assert "Profile = Untitled" in text  # the other section's line is untouched


def test_oink_default_configured_requires_collection_and_basic(tmp_path, cfg, monkeypatch):
    monkeypatch.setattr(obs_profile, "run", _run_noop)
    c = _cfg_with(tmp_path, cfg)
    # No collection → not configured.
    assert obs_profile._oink_default_configured(c) is False
    # Write the template collection.
    obs_profile._write_oink_collection(c)
    # Collection present but [Basic] not pointing at oink → not configured.
    assert obs_profile._oink_default_configured(c) is False
    # Point [Basic] at oink → configured.
    obs_profile._set_oink_default(c)
    assert obs_profile._oink_default_configured(c) is True


def test_remove_untitled_deletes_profile_and_collection(tmp_path, cfg, monkeypatch):
    monkeypatch.setattr(obs_profile, "run", _run_noop)
    c = _cfg_with(tmp_path, cfg)
    prof = c.obs_cfg / "basic" / "profiles" / "Untitled"
    (prof / "sub").mkdir(parents=True)
    (prof / "basic.ini").write_text("[SimpleOutput]\n")
    coll = c.obs_cfg / "basic" / "scenes" / "Untitled.json"
    coll.parent.mkdir(parents=True, exist_ok=True)
    coll.write_text("{}")

    obs_profile._remove_untitled(c)

    assert not prof.exists()
    assert not coll.exists()
    # A stray unrelated collection is untouched.
    other = c.obs_cfg / "basic" / "scenes" / "oink.json"
    other.write_text("{}")
    obs_profile._remove_untitled(c)
    assert other.exists()


# ── Golden vertical template validation ──────────────────────────────────────

def test_vertical_template_structure(cfg):
    """The committed template must define the Aitum Vertical canvas, one vertical
    scene per default main scene (empty containers — the ingest is provisioned at
    runtime into both main and vertical), and the settings.canvas link on each
    main scene."""
    from constants import MAIN_CANVAS_UUID, VERTICAL_CANVAS_UUID, VERTICAL_TEMPLATE
    data = json.loads(cfg.template(VERTICAL_TEMPLATE))

    assert data.get("name") == "oink"  # collection renamed away from Untitled

    canvases = {c["info"]["name"] for c in data.get("canvases", [])}
    assert "Aitum Vertical" in canvases
    assert "Vertical" not in canvases  # stale canvas stripped

    main_canvas = MAIN_CANVAS_UUID
    vertical_canvas = VERTICAL_CANVAS_UUID
    names = ["main", "brb", "privacy", "offline", "low-br"]

    main_scenes = {}
    vertical_scenes = {}
    for s in data["sources"]:
        if s["id"] != "scene":
            continue
        if s.get("canvas_uuid") == main_canvas:
            main_scenes[s["name"]] = s
        elif s.get("canvas_uuid") == vertical_canvas:
            vertical_scenes[s["name"]] = s

    assert set(main_scenes) == set(names)
    assert set(vertical_scenes) == set(names)

    # Each main scene carries the vertical link.
    for n in names:
        canvas = main_scenes[n]["settings"].get("canvas")
        assert canvas == [{"width": 1080, "height": 1920, "scene": n}]

    # Vertical scenes are empty containers — no nested scene-source mirror. The
    # ingest source is added to both main and vertical at runtime via obs-websocket.
    for n in names:
        assert vertical_scenes[n]["settings"]["items"] == []

    # No host-specific ingest source leaked into the template.
    assert not any(s.get("id") == "irl_source" for s in data["sources"])
    assert not any(s.get("id") == "ffmpeg_source" for s in data["sources"])


# ── Preview crop persistence ──────────────────────────────────────────────────

def test_preview_crop_persistence(cfg):
    """Both preview templates persist crop per path so toggling the settings
    control (which reloads the iframe) keeps tuned values, and share defaults."""
    defaults = set()
    for name in ("preview-client.html", "preview-dashboard.html"):
        html = cfg.template(name)
        assert "CROP_STORAGE_KEY = 'oinkCrop:' + location.pathname" in html
        assert "localStorage.getItem(CROP_STORAGE_KEY" in html
        assert "localStorage.setItem(CROP_STORAGE_KEY" in html
        assert "saveCrop();" in html  # persisted on every change
        for line in html.splitlines():
            if "const DEFAULT_CROP" in line:
                defaults.add(line.strip())
    assert len(defaults) == 1  # templates stay in sync


def test_scenes_default_output_1080p30(cfg):
    """The scenes helper converges the profile onto the dashboard's 1080p30
    preset (resolution + fps + bitrate) so /settings highlights it by default."""
    src = cfg.template("scenes.py")
    assert 'PRESET_VIDEO = (1920, 1080, 30, 6000)' in src
    assert 'if current == PRESET_VIDEO:' in src
    assert '"SetVideoSettings"' in src
    assert '"VBitrate", "parameterValue": "6000"' in src


def test_firewall_guard_blocks_loopback_only_ports(cfg):
    """obs-websocket (4455) and x11vnc (5900) cannot bind loopback fully; the
    guard must drop inbound on both from non-loopback (IPv4+IPv6 via `inet`),
    and the unit must run it before those services start."""
    script = cfg.template("oink-firewall.sh")
    assert 'tcp dport "$port" drop' in script
    assert 'PORTS="4455 5900"' in script
    assert 'iifname != "lo"' in script
    assert "inet" in script

    unit = cfg.template("oink-firewall.service")
    assert "ExecStart=$OINK_LIBEXEC/oink-firewall.sh" in unit
    assert "Before=oink-obs.service oink-vnc.service" in unit


def test_vnc_unit_orders_after_firewall_guard(cfg):
    """The VNC unit must not rely on ip6tables (not a declared dep); the nft
    guard is pulled in and ordered first so :5900 is dropped before bind."""
    unit = cfg.template("oink-vnc.service")
    assert "Wants=oink-firewall.service" in unit
    assert "After=oink-firewall.service" in unit
    assert "ip6tables" not in unit


def test_dry_run_host_sections_write_nothing(tmp_path, cfg, monkeypatch):
    """`oink setup --dry-run` must not touch the filesystem: every host section
    that can write is run with dry_run=True and all write primitives are trapped."""
    import os

    # Plugin marker must exist before we trap writes (so §6c gets past its guard).
    (tmp_path / "obs-studio/plugins/vertical-canvas").mkdir(parents=True)
    (tmp_path / "obs-studio/plugins/vertical-canvas/v.so").write_bytes(b"x")

    c = cfg.__class__(**{**cfg.__dict__,
                         "home": tmp_path, "obs_home": tmp_path,
                         "obs_cfg": tmp_path / "obs-studio",
                         "obs_ws": tmp_path / "obs-studio/plugin_config/obs-websocket",
                         "global_ini": tmp_path / "obs-studio/global.ini",
                         "user_ini_root": tmp_path / "obs-studio/user.ini",
                         "user_ini": tmp_path / "obs-studio/user.ini",
                         "guac_dir": tmp_path / "guac",
                         "dep_dir": tmp_path / "deps",
                         "recording_dir": tmp_path / "recs",
                         "stack_dir": tmp_path / "stack",
                         "dry_run": True, "auto_yes": True})

    writes: list[str] = []

    def trap(name):
        def _trap(*_a, **_k):
            writes.append(name)
        return _trap

    for meth in ("write_text", "write_bytes", "mkdir", "touch", "unlink", "symlink_to"):
        monkeypatch.setattr(pathlib.Path, meth, trap(f"Path.{meth}"))
    for mod, meth in ((shutil, "rmtree"), (shutil, "copy2"), (shutil, "copytree"),
                      (os, "chmod"), (os, "replace"), (os, "chown")):
        monkeypatch.setattr(mod, meth, trap(f"{mod.__name__}.{meth}"))

    monkeypatch.setattr(sections, "run", _run_noop)
    monkeypatch.setattr(sections, "run_ok", lambda *a, **k: True)
    monkeypatch.setattr(sections, "wait_port", lambda *a, **k: False)
    monkeypatch.setattr(sections, "_node_22_ok", lambda c_: True)
    monkeypatch.setattr(sections, "OINK_LIBEXEC", tmp_path / "libexec")
    monkeypatch.setattr(sections, "OINK_CLI", tmp_path / "bin/oink")
    monkeypatch.setattr(obs_profile, "run", _run_noop)
    monkeypatch.setattr(obs_profile, "run_ok", lambda *a, **k: True)
    monkeypatch.setattr(obs_profile, "_obs_semver_at_least", lambda c_, m: True)

    state = HostState(obs_password="pw")
    for fn in (sections.section_dummy_display, sections.section_oink_display,
               sections.section_obs_install, sections.section_obs_golden,
               sections.section_obs_websocket, sections.section_oink_obs,
               sections.section_obs_scenes, sections.section_oink_vnc,
               sections.section_guacamole, obs_profile.section_obs_vertical):
        assert fn(c, state).success

    assert writes == [], f"dry-run wrote: {sorted(set(writes))}"
