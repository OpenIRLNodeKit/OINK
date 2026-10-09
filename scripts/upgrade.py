# SPDX-FileCopyrightText: 2026 OpenIRLNodeKit contributors
# SPDX-License-Identifier: AGPL-3.0-or-later
"""upgrade.py — `oink upgrade`: check the pinned components against their GitHub
releases, then re-pin and reinstall the ones you select.

Every component OINK downloads (the MediaMTX/NOALBS binaries and the default OBS
plugins) carries `repo` + `asset` metadata in stack/components.json. This module
asks GitHub for the newest non-prerelease release, matches the linux asset, and
reads its published sha256 — so a bump is `oink upgrade` instead of hand-editing
version + url + sha256. `oink upgrade --check` only reports; without `--check` it
rewrites the manifest and runs the full setup to apply.
"""

from __future__ import annotations

import json
import os
import re
import urllib.error
import urllib.request
from collections.abc import Callable

from constants import COMPONENTS_FILE, DEFAULT_PLUGINS
from logui import C, err, info, warn

_API = "https://api.github.com/repos/{repo}/releases/latest"

# Human labels for the per-component status column.
_STATUS_LABEL = {
    "update": "update available",
    "current": "up to date",
    "ahead": "pinned ahead of latest",
    "error": "check failed",
}


class UpgradeError(Exception):
    """A component's latest release could not be resolved from GitHub."""


def _get_json(url: str) -> dict:
    headers = {"Accept": "application/vnd.github+json", "User-Agent": "oink-upgrade"}
    token = os.environ.get("GITHUB_TOKEN")
    if token:
        headers["Authorization"] = f"Bearer {token}"
    req = urllib.request.Request(url, headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:  # noqa: S310 (fixed https host)
            return json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        raise UpgradeError(f"GitHub API returned HTTP {e.code}") from e
    except (urllib.error.URLError, TimeoutError, json.JSONDecodeError) as e:
        raise UpgradeError(f"GitHub request failed: {e}") from e


def _semver(text: str) -> tuple[int, ...]:
    """Numeric version tuple from a tag or pin (leading 'v'/prefixes ignored)."""
    return tuple(int(p) for p in re.findall(r"\d+", text))


def is_newer(current: str, latest: str) -> bool:
    return _semver(latest) > _semver(current)


def _fetch_latest(meta: dict) -> dict:
    """Resolve the newest release asset matching meta['asset'] to pin fields."""
    data = _get_json(_API.format(repo=meta["repo"]))
    tag = (data.get("tag_name") or "").strip()
    if not tag:
        raise UpgradeError("release has no tag_name")
    pattern = re.compile(meta["asset"])
    for asset in data.get("assets") or []:
        if pattern.match(asset.get("name", "")):
            digest = asset.get("digest") or ""
            if not digest.startswith("sha256:"):
                raise UpgradeError(f"asset {asset.get('name')} has no sha256 digest")
            return {
                "version": tag.lstrip("v"),
                "url": asset["browser_download_url"],
                "sha256": digest.removeprefix("sha256:"),
            }
    raise UpgradeError(f"no asset matching {meta['asset']} in {tag}")


def collect() -> list[dict]:
    """Check every component, one GitHub request each; failures never abort."""
    components = [("binary", name, meta)
                  for name, meta in DEFAULT_PLUGINS.get("binaries", {}).items()]
    components += [("plugin", meta["name"], meta)
                   for meta in DEFAULT_PLUGINS.get("plugins", [])]
    rows: list[dict] = []
    for kind, name, meta in components:
        row = {"kind": kind, "name": name, "current": meta.get("version", ""),
               "latest": "", "url": "", "sha256": "", "status": "error", "detail": ""}
        if not meta.get("repo") or not meta.get("asset"):
            row["detail"] = "no repo/asset metadata"
            rows.append(row)
            continue
        try:
            latest = _fetch_latest(meta)
        except UpgradeError as e:
            row["detail"] = str(e)
            rows.append(row)
            continue
        row.update(latest=latest["version"], url=latest["url"], sha256=latest["sha256"])
        if is_newer(row["current"], latest["version"]):
            row["status"] = "update"
        elif _semver(latest["version"]) == _semver(row["current"]):
            row["status"] = "current"
        else:
            row["status"] = "ahead"
        rows.append(row)
    return rows


def render(rows: list[dict]) -> None:
    for i, r in enumerate(rows, 1):
        latest = r["latest"] or "?"
        line = (f"  {i:>2}. {r['name']:<20} {r['current']} → {latest:<12}"
                f"[{_STATUS_LABEL[r['status']]}]")
        if r["detail"]:
            line += f"  ({r['detail']})"
        colour = {"update": C["green"], "error": C["red"], "ahead": C["yellow"]}.get(r["status"], "")
        print(f"{colour}{line}{C['nc'] if colour else ''}")


def select(rows: list[dict], auto_yes: bool) -> list[dict]:
    """Ask which updatable components to bump. Empty selection cancels."""
    updatable = [r for r in rows if r["status"] == "update"]
    if not updatable or auto_yes:
        return updatable
    print()
    for i, r in enumerate(updatable, 1):
        print(f"  {i:>2}) {r['name']}  {r['current']} → {r['latest']}")
    print("Select components to upgrade — space-separated numbers, 'a' for all, Enter to cancel:")
    try:
        raw = input("> ").strip()
    except (EOFError, KeyboardInterrupt):
        return []
    if raw.lower() in ("a", "all"):
        return updatable
    chosen = []
    for tok in raw.split():
        if tok.isdigit() and 1 <= int(tok) <= len(updatable):
            chosen.append(updatable[int(tok) - 1])
    return chosen


def apply(selected: list[dict]) -> None:
    """Rewrite the selected components' version/url/sha256 in components.json."""
    doc = json.loads(COMPONENTS_FILE.read_text())
    binaries = doc.get("binaries", {})
    plugins = {p["name"]: p for p in doc.get("plugins", [])}
    for r in selected:
        target = binaries.get(r["name"]) if r["kind"] == "binary" else plugins.get(r["name"])
        if target is None:
            continue
        target["version"] = r["latest"]
        target["url"] = r["url"]
        target["sha256"] = r["sha256"]
    COMPONENTS_FILE.write_text(json.dumps(doc, indent=2) + "\n")


def upgrade_main(cfg, *, check_only: bool, auto_yes: bool,
                 install: Callable[[], int]) -> int:
    """Check, select, re-pin, then run `install()` (full setup). Restores the
    previous pins if the install fails, so the manifest never points at a
    version that could not be installed."""
    info(cfg, "Checking pinned components against GitHub releases…")
    rows = collect()
    print()
    render(rows)
    print()

    if any(r["status"] == "error" for r in rows):
        warn(cfg, "Some components could not be checked — see the errors above.")
    if check_only:
        return 0
    if not any(r["status"] == "update" for r in rows):
        info(cfg, "  → Every component is at its latest release.")
        return 0

    selected = select(rows, auto_yes)
    if not selected:
        info(cfg, "  → Nothing selected; no changes made.")
        return 0

    backup = COMPONENTS_FILE.read_text()
    apply(selected)
    info(cfg, "  → Pinned " + ", ".join(r["name"] for r in selected)
              + " — running setup to apply…")
    rc = install()
    if rc != 0:
        COMPONENTS_FILE.write_text(backup)
        err(cfg, "  → Install failed; restored the previous pins in components.json.")
        return rc
    return 0
