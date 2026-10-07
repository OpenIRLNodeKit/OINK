#!/usr/bin/env bash
# SPDX-FileCopyrightText: 2026 OpenIRLNodeKit contributors
# SPDX-License-Identifier: AGPL-3.0-or-later
# OpenIRLNodeKit bootstrap installer.
#
#   curl -fsSL https://openirlnodekit.com/install.sh | sudo bash
#
# Clones the repo to /opt/OpenIRLNodeKit and runs `oink.py setup -y`. Flags after
# `-s --` are passed to setup (e.g. `--dry-run`). Must run as root (the installer
# drives apt + systemd). Unattended configuration goes through `OINK_*` env vars:
#   curl -fsSL … | sudo OINK_ADMIN_PASSWORD=… OINK_INGEST_KEY=… bash -s -- -y
set -euo pipefail

REPO="https://github.com/OpenIRLNodeKit/OINK.git"
DIR="/opt/OpenIRLNodeKit"

die() { echo "oink-install: $*" >&2; exit 1; }

[ "$(id -u)" -eq 0 ] || die "must run as root — try: curl -fsSL <url> | sudo bash"

[ -r /etc/os-release ] && . /etc/os-release
[ "${ID:-}" = "ubuntu" ] || die "unsupported OS '${ID:-unknown}' — Ubuntu 24.04 required"

command -v git >/dev/null 2>&1 || { echo "oink-install: installing git…"; apt-get update -qq && apt-get install -y -qq git; }
command -v python3 >/dev/null 2>&1 || { echo "oink-install: installing python3…"; apt-get update -qq && apt-get install -y -qq python3; }

if [ -d "$DIR/.git" ]; then
    echo "oink-install: updating checkout in $DIR (main)…"
    git -C "$DIR" fetch --depth 1 origin main
    git -C "$DIR" checkout -q -f FETCH_HEAD
else
    echo "oink-install: cloning $REPO → $DIR…"
    git clone --depth 1 --branch main "$REPO" "$DIR"
fi
echo "oink-install: checkout at $(git -C "$DIR" rev-parse --short HEAD)"

exec python3 "$DIR/oink.py" setup -y "$@"
