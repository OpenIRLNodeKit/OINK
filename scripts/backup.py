#!/usr/bin/env python3
# SPDX-FileCopyrightText: 2026 OpenIRLNodeKit contributors
# SPDX-License-Identifier: AGPL-3.0-or-later
"""backup.py — `oink backup` / `oink restore`.

Zip archive of the box state that `oink setup` does NOT recreate: the ingest
stream key, control-plane secrets, NOALBS config, and the OBS scene
collections/profiles. Dashboard accounts (`users.json`) are deliberately
excluded: credentials stay on the box and restore never replaces the target's
accounts. Regenerable files (nginx.conf, web build, binaries) and large media
(recordings) are deliberately excluded; uploaded assets are opted in with
`--assets`.

Archive layout (see _iter_sources for the exact set):

    manifest.json          # format version + per-file sha256/mode
    stack/...              # from ~<obs_user>/oink/stack
    obs/...                # from ~<obs_user>/.config/obs-studio
    assets/...             # from ~<obs_user>/dependencies (only with --assets)

Secrets are included, so the archive is written 0600. `--encrypt` wraps it with
`openssl enc` (AES-256-CBC/PBKDF2) for off-box transport; restore auto-detects.
"""

from __future__ import annotations

import getpass
import hashlib
import json
import os
import pathlib
import re
import secrets
import tempfile
import time
import zipfile

import stack
from logui import bail, confirm, info, warn
from models import SetupConfig
from process import run, run_ok

MANIFEST_NAME = "manifest.json"
FORMAT_VERSION = 1
PASSPHRASE_ENV = "OINK_BACKUP_PASSPHRASE"

# Shared with stack/backup.js (the dashboard) so the two never drift.
_SET_FILE = pathlib.Path(__file__).resolve().parent.parent / "stack" / "backup-set.json"
_ROOT_ATTR = {"stack": "stack_dir", "obs": "obs_cfg",
              "assets": "dep_dir", "recordings": "recording_dir"}

# Units that must not be mid-write while their files are swapped; restarted only
# if they were active before the restore.
_UNITS = ("oink-obs", "oink-api", "oink-noalbs", "oink-mediamtx", "oink-srtla", "oink-guac")


def _load_set(include_toggles: set[str] | None = None) -> list[dict]:
    """Read the shared backup-set entries.

    Entries without `toggle` are always included; `toggle` entries are included
    only when their key is in `include_toggles` (CLI opt-in, e.g. `--assets`).
    """
    include_toggles = include_toggles or set()
    try:
        data = json.loads(_SET_FILE.read_text())
    except (OSError, ValueError) as e:
        raise SystemExit(f"error: backup set unreadable ({_SET_FILE}): {e}") from e
    return [e for e in data.get("entries", [])
            if e.get("backup") is not False
            and (not e.get("toggle") or e.get("toggle") in include_toggles)]


def _keep_current_arcs() -> set[str]:
    """Arc names of `backup: false` entries: never written, never restored."""
    try:
        data = json.loads(_SET_FILE.read_text())
    except (OSError, ValueError):
        return set()
    return {f"{e['root']}/{e['rel']}" for e in data.get("entries", [])
            if e.get("backup") is False and e.get("rel")}


def _sha256_file(path: pathlib.Path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(65536), b""):
            h.update(chunk)
    return h.hexdigest()


def _iter_sources(cfg: SetupConfig,
                  include_toggles: set[str] | None = None) -> tuple[list[tuple[pathlib.Path, str, int]], list[str]]:
    """Collect backup sources as (path, arcname, mode) plus a list of missing ones.

    Entries come from the shared stack/backup-set.json; toggle entries (assets,
    recordings) are opt-in via `include_toggles`. Missing sources are not fatal
    — reported so the operator knows the archive is partial.
    """
    sources: list[tuple[pathlib.Path, str, int]] = []
    missing: list[str] = []

    def add_file(base: pathlib.Path, prefix: str, rel: str) -> None:
        p = base / rel
        if p.is_file():
            sources.append((p, f"{prefix}/{rel}", p.stat().st_mode))
        else:
            missing.append(f"{prefix}/{rel}")

    def add_dir(base: pathlib.Path, prefix: str, rel: str) -> None:
        root = base / rel
        if not root.is_dir():
            missing.append(f"{prefix}/{rel}/")
            return
        for p in sorted(root.rglob("*")):
            # Skip our own restore safety copies so repeated backups don't grow.
            if p.is_file() and ".pre-restore-" not in p.name:
                arc = f"{prefix}/{rel}/{p.relative_to(root)}" if rel else f"{prefix}/{p.relative_to(root)}"
                sources.append((p, arc, p.stat().st_mode))

    for entry in _load_set(include_toggles):
        base = getattr(cfg, _ROOT_ATTR[entry["root"]])
        prefix = entry["root"]
        if entry["kind"] == "file":
            add_file(base, prefix, entry["rel"])
        else:
            add_dir(base, prefix, entry["rel"])

    return sources, missing


def _build_manifest(sources: list[tuple[pathlib.Path, str, int]]) -> dict:
    files = [
        {"path": arc, "sha256": _sha256_file(p), "mode": f"{m & 0o777:04o}"}
        for p, arc, m in sources
    ]
    return {
        "version": FORMAT_VERSION,
        "created_at": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
        "files": files,
    }


def _add_manifest(zf: zipfile.ZipFile, manifest: dict) -> None:
    zf.writestr(MANIFEST_NAME, json.dumps(manifest, indent=2))


def _passphrase(confirm: bool = False) -> str:
    env = os.environ.get(PASSPHRASE_ENV)
    if env:
        return env
    first = getpass.getpass("Backup passphrase: ")
    if confirm and first != getpass.getpass("Confirm passphrase: "):
        raise SystemExit("error: passphrases do not match")
    return first


def _openssl(cfg: SetupConfig, args: list[str], passphrase: str) -> None:
    r = run(cfg, "openssl", "enc", *args, input=passphrase + "\n", capture=True, check=False)
    if r.returncode != 0:
        bail(cfg, f"openssl enc failed: {(r.stderr or '').strip() or f'exit {r.returncode}'}")


def _notify_exclusions(cfg: SetupConfig, included: set[str]) -> None:
    """Tell the operator what a backup deliberately leaves out."""
    paths = {"assets": cfg.dep_dir, "recordings": cfg.recording_dir}
    skipped = [f"{k} ({p})" for k, p in paths.items() if k not in included]
    warn(cfg, "  → not included: dashboard accounts (users.json)")
    if skipped:
        warn(cfg, "  → not included: " + ", ".join(skipped))


def create_backup(cfg: SetupConfig, out: pathlib.Path, *, encrypt: bool = False,
                  passphrase: str | None = None, assets: bool = False) -> pathlib.Path:
    """Write the backup archive to `out`; returns the final path (`.enc` if encrypted)."""
    included = {"assets"} if assets else set()
    sources, missing = _iter_sources(cfg, included)
    for m in missing:
        warn(cfg, f"  → not present, skipping: {m}")
    if not sources:
        bail(cfg, "nothing to back up — is this an installed node?")

    manifest = _build_manifest(sources)
    tmp = out.with_name(out.name + ".tmp")
    try:
        with zipfile.ZipFile(tmp, "w", zipfile.ZIP_DEFLATED) as zf:
            for p, arc, _ in sources:
                zf.write(p, arcname=arc)
            _add_manifest(zf, manifest)
        os.chmod(tmp, 0o600)
        _notify_exclusions(cfg, included)
        if encrypt:
            final = out.with_name(out.name + ".enc")
            _openssl(cfg, ["-aes-256-cbc", "-pbkdf2", "-salt", "-in", str(tmp),
                           "-out", str(final), "-pass", "stdin"],
                     passphrase or _passphrase(confirm=True))
            tmp.unlink()
            os.chmod(final, 0o600)
            return final
        tmp.replace(out)
        return out
    except BaseException:
        if tmp.exists():
            tmp.unlink()
        raise


def _decrypt_to_temp(cfg: SetupConfig, archive: pathlib.Path) -> pathlib.Path:
    passphrase = _passphrase()
    fd, name = tempfile.mkstemp(prefix="oink-restore-", suffix=".zip")
    os.close(fd)
    tmp = pathlib.Path(name)
    _openssl(cfg, ["-d", "-aes-256-cbc", "-pbkdf2", "-in", str(archive),
                   "-out", str(tmp), "-pass", "stdin"], passphrase)
    return tmp


def _read_archive(cfg: SetupConfig, archive: pathlib.Path) -> tuple[zipfile.ZipFile, dict]:
    """Open the archive and return (zipfile, manifest). Caller must close it."""
    try:
        zf = zipfile.ZipFile(archive)
    except (zipfile.BadZipFile, OSError) as e:
        bail(cfg, f"not a readable backup archive: {e}")
    try:
        manifest = json.loads(zf.read(MANIFEST_NAME))
    except (KeyError, ValueError, OSError):
        manifest = None
    if not isinstance(manifest, dict) or "files" not in manifest:
        zf.close()
        bail(cfg, "archive is missing a valid manifest.json")
    if manifest.get("version") != FORMAT_VERSION:
        zf.close()
        bail(cfg, f"unsupported backup format version: {manifest.get('version')!r}")
    return zf, manifest


def _verify(cfg: SetupConfig, zf: zipfile.ZipFile, manifest: dict, force: bool) -> list[str]:
    """Check every manifest entry's sha256; returns problems (empty = OK)."""
    problems: list[str] = []
    for entry in manifest["files"]:
        arc = entry.get("path", "")
        try:
            digest = hashlib.sha256(zf.read(arc)).hexdigest()
        except (KeyError, OSError):
            digest = ""
        if digest != entry.get("sha256"):
            problems.append(arc)
    if problems and not force:
        bail(cfg, "checksum mismatch (archive corrupt or tampered): "
                  + ", ".join(problems) + " — re-run with --force to override")
    for p in problems:
        warn(cfg, f"  → checksum mismatch (forced): {p}")
    return problems


def _safe_member(name: str) -> bool:
    return bool(name) and not name.startswith("/") and ".." not in pathlib.PurePosixPath(name).parts


def _target_for(cfg: SetupConfig, arc: str) -> pathlib.Path | None:
    root, _, rest = arc.partition("/")
    attr = _ROOT_ATTR.get(root)
    if attr is None:
        return None
    base = getattr(cfg, attr)
    return base / rest if rest else base


def _active_units(cfg: SetupConfig) -> set[str]:
    return {u for u in _UNITS if run_ok(cfg, "systemctl", "is-active", "--quiet", u)}


def restore_backup(cfg: SetupConfig, archive: pathlib.Path, *, force: bool = False) -> None:
    if not archive.is_file():
        bail(cfg, f"backup file not found: {archive}")

    encrypted = not zipfile.is_zipfile(archive)
    if encrypted and cfg.dry_run:
        info(cfg, f"  [dry-run] Would decrypt {archive} (passphrase required)")
        return
    work = _decrypt_to_temp(cfg, archive) if encrypted else archive
    try:
        zf, manifest = _read_archive(cfg, work)
        try:
            _verify(cfg, zf, manifest, force)
            _apply(cfg, zf, manifest)
        finally:
            zf.close()
    finally:
        if work != archive:
            work.unlink(missing_ok=True)


_AUTH_KEYS = ("OINK_SESSION_SECRET", "OINK_ADMIN_PASSWORD",
              "OINK_ADMIN_PASSWORD_ORIGIN", "OINK_SETUP_TOKEN")


def _read_api_env(cfg: SetupConfig) -> list[str]:
    try:
        return (cfg.stack_dir / "api.env").read_text().splitlines()
    except OSError:
        return []


_SRT_INGEST_RE = re.compile(r"^srt://[^/?#]+:8890(?=[/?#]|$)", re.IGNORECASE)


def _localize_urls(value):
    """Point restored OINK SRT read URLs at this box's loopback MediaMTX."""
    if isinstance(value, str):
        return _SRT_INGEST_RE.sub("srt://127.0.0.1:8890", value)
    if isinstance(value, list):
        return [_localize_urls(v) for v in value]
    if isinstance(value, dict):
        return {k: _localize_urls(v) for k, v in value.items()}
    return value


def _localize_scene_file(path: pathlib.Path) -> None:
    """Rewrite the source box's ingest host in a restored OBS scene config.

    Only `srt://<host>:8890` URLs are touched (this box's MediaMTX); external
    SRT feeds and other ports stay as the backup recorded them.
    """
    try:
        data = json.loads(path.read_text())
        path.write_text(json.dumps(_localize_urls(data)))
    except (OSError, ValueError):
        pass


def _sync_noalbs_obs_password(cfg: SetupConfig) -> None:
    """Keep this install's OBS websocket password in the restored NOALBS config.

    The archive carries the source box's password in `software.password`, which
    never matches this OBS. Missing password file or unparseable config: leave
    the restored file untouched.
    """
    try:
        pw = (cfg.obs_ws / "password").read_text().strip()
    except OSError:
        return
    if not pw:
        return
    cfg_json = cfg.stack_dir / "noalbs" / "config.json"
    try:
        data = json.loads(cfg_json.read_text())
    except (OSError, ValueError):
        return
    if not isinstance(data, dict) or not isinstance(data.get("software"), dict):
        return
    if data["software"].get("password") == pw:
        return
    data["software"]["password"] = pw
    cfg_json.write_text(json.dumps(data, indent=2) + "\n")
    cfg_json.chmod(0o600)


def _restore_auth_env(cfg: SetupConfig, previous: list[str], *,
                      had_users: bool) -> str | None:
    """Keep this install's credentials; never apply the archive's auth lines.

    Returns the generated admin password when the target had no accounts
    (fresh-box restore), so the caller can print it once.
    """
    def key(line: str) -> str:
        return line.split("=", 1)[0].strip()

    kept = [ln for ln in previous if key(ln) in _AUTH_KEYS]
    restored = [ln for ln in _read_api_env(cfg) if key(ln) not in _AUTH_KEYS]
    if not restored:
        # Archive carried no api.env: keep this install's non-auth settings too.
        restored = [ln for ln in previous if key(ln) not in _AUTH_KEYS]
    session_secret = next(
        (ln.split("=", 1)[1] for ln in kept if ln.startswith("OINK_SESSION_SECRET=")), "",
    )
    if not session_secret:
        session_secret = secrets.token_urlsafe(32)
        kept.insert(0, f"OINK_SESSION_SECRET={session_secret}")

    password = None
    if had_users:
        auth = kept
    else:
        # Fresh box: the archive has no credentials by design, so print a new
        # one-shot password instead of sending the operator back to /setup.
        password = secrets.token_urlsafe(12)
        auth = [f"OINK_SESSION_SECRET={session_secret}",
                f"OINK_ADMIN_PASSWORD={password}"]

    env_file = cfg.stack_dir / "api.env"
    env_file.parent.mkdir(parents=True, exist_ok=True)
    env_file.write_text("\n".join(auth + restored) + "\n")
    env_file.chmod(0o600)
    return password


def _apply(cfg: SetupConfig, zf: zipfile.ZipFile, manifest: dict) -> None:
    keep = _keep_current_arcs()
    # Snapshot credentials before any file is renamed or overwritten.
    previous_env = _read_api_env(cfg)
    had_users = stack._has_dashboard_users(cfg)  # noqa: SLF001

    entries = [e for e in manifest["files"] if _safe_member(e.get("path", ""))
               and _target_for(cfg, e["path"]) is not None]
    kept_arcs = [e["path"] for e in entries if e["path"] in keep]
    entries = [e for e in entries if e["path"] not in keep]
    if kept_arcs:
        info(cfg, "  → Keeping current install accounts: " + ", ".join(kept_arcs))
    if not entries:
        bail(cfg, "archive carries no restorable files")

    existing = [e["path"] for e in entries if _target_for(cfg, e["path"]).exists()]
    info(cfg, f"  → Restore plan: {len(entries)} files "
              f"({len(existing)} overwrite, {len(entries) - len(existing)} new)")
    for arc in existing:
        print(f"      overwrite {arc}")

    if cfg.dry_run:
        info(cfg, "  [dry-run] No files written")
        return
    if not confirm(cfg, f"Restore {len(entries)} files over the installed state?"):
        info(cfg, "  → Aborted")
        return

    stamp = time.strftime("%Y%m%d-%H%M%S")
    for arc in existing:
        p = _target_for(cfg, arc)
        try:
            p.replace(p.with_name(p.name + f".pre-restore-{stamp}"))
        except OSError as e:
            warn(cfg, f"  → could not back up {p}: {e}")

    active = _active_units(cfg)
    for u in _UNITS:
        if u in active:
            run(cfg, "systemctl", "stop", u, check=False)
            info(cfg, f"  → stopped {u}")

    modes = {e["path"]: e.get("mode") for e in entries}
    for e in entries:
        arc = e["path"]
        target = _target_for(cfg, arc)
        assert target is not None
        try:
            data = zf.read(arc)
        except KeyError:
            warn(cfg, f"  → archive entry vanished: {arc}")
            continue
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(data)
        mode = modes.get(arc)
        if mode:
            os.chmod(target, int(mode, 8))
        if arc.startswith("obs/basic/scenes/") and arc.endswith(".json"):
            _localize_scene_file(target)

    fresh_password = _restore_auth_env(cfg, previous_env, had_users=had_users)
    _sync_noalbs_obs_password(cfg)
    if fresh_password:
        info(cfg, "  → No accounts in the current install: seeded a new admin")
        print(f"\n  Dashboard login: admin / {fresh_password}")
        info(cfg, "  → Shown once. Change it after signing in.\n")

    # Observed dirs may have nested files not enumerated in the manifest digest
    # list? They are all enumerated, but chown the whole touched trees anyway.
    for base in {cfg.stack_dir, cfg.obs_cfg}:
        if base.exists():
            run(cfg, "chown", "-R", f"{cfg.obs_user}:{cfg.obs_user}", str(base), check=False)
    info(cfg, "  → Restored files (mode + ownership applied)")

    # Older/partial archives may lack the keyed mediamtx.yml; re-render it from the
    # restored ingest.json so the stream-key namespace can't drift.
    if not any(e["path"] == "stack/mediamtx.yml" for e in entries):
        warn(cfg, "  → archive has no mediamtx.yml; re-rendering from restored ingest.json")
        try:
            stack._bootstrap_ingest(cfg)  # noqa: SLF001
        except SystemExit as e:
            warn(cfg, f"  → mediamtx re-render failed: {e}")

    for u in _UNITS:
        if u in active:
            run(cfg, "systemctl", "start", u, check=False)
            info(cfg, f"  → started {u}")


def backup_main(cfg: SetupConfig, out: pathlib.Path, encrypt: bool = False,
                passphrase: str | None = None, assets: bool = False) -> int:
    final = create_backup(cfg, out, encrypt=encrypt, passphrase=passphrase, assets=assets)
    size = final.stat().st_size
    info(cfg, f"  → Backup written: {final} ({size} bytes)")
    return 0


def restore_main(cfg: SetupConfig, archive: pathlib.Path, force: bool = False) -> int:
    restore_backup(cfg, archive, force=force)
    return 0
