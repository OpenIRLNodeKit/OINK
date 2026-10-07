#!/bin/sh
# SPDX-FileCopyrightText: 2026 OpenIRLNodeKit contributors
# SPDX-License-Identifier: AGPL-3.0-or-later
# oink-pin-recordings.sh — assert every OBS profile records into $RECORDING_DIR.
#
# Idempotently ensures the OBS recording output path resolves to
# $RECORDING_DIR in each basic/profiles/*/basic.ini so recorded clips always
# land in the monitored /home/<user>/recordings dir that the log-server reads
# for the /api/recordings endpoints.
#
# OBS stores the simple-output path under [SimpleOutput] RecFilePath but a
# profile that has ever carried advanced-output settings ALSO keeps an
# [AdvOut] RecFilePath (+ FFFilePath) which OBS prefers to resolve the live
# record directory. Both must be pinned or the real path can silently drift to
# ~.
#
# This is boot + `oink setup` hardening: the path is otherwise only driven once
# via a websocket SetProfileParameter at install time. If OBS creates/duplicates
# a profile later (e.g. "oink2"), RecFilePath resets and, worse, a drift to
# AdvOut points at ~. Running this before every OBS launch (and from the stack
# phase) pins the path no matter what profile or output mode is active.

set -eu
RECORDING_DIR=${1:-/home/obsuser/recordings}
case "$RECORDING_DIR" in
  /*) ;;                # absolute path required
  *) echo "error: recording dir must be absolute: $RECORDING_DIR" >&2; exit 1 ;;
esac

# Derive the OBS config root from the recordings dir: <home>/.config/obs-studio
home="${RECORDING_DIR%/recordings}"
CONFIG_DIR="$home/.config/obs-studio"

PROFILE_DIR="$CONFIG_DIR/basic/profiles"
[ -d "$PROFILE_DIR" ] || { echo "no profiles dir ($PROFILE_DIR) — nothing to pin"; exit 0; }

# Pin a key=value under a named INI section, creating the section if absent.
# Writes into $tmp and rewrites $ini atomically. Used for both sections.
pin_section_key() { # section key value ini
    section="$1"; key="$2"; value="$3"; ini="$4"; tmp="${ini}.oink-tmp.$$"
    if [ -f "$ini" ]; then
        if grep -q "^\[$section\]$" "$ini"; then
            if grep -q "^$key=" "$ini"; then
                sed "s|^$key=.*$|$key=$value|" "$ini" > "$tmp"
            else
                sed "/^\[$section\]$/a $key=$value" "$ini" > "$tmp"
            fi
        else
            cp "$ini" "$tmp"; printf '\n[%s]\n%s=%s\n' "$section" "$key" "$value" >> "$tmp"
        fi
        mv -f "$tmp" "$ini"
    else
        printf '[%s]\n%s=%s\n' "$section" "$key" "$value" > "$ini"
    fi
}

pinned=0
for profile in "$PROFILE_DIR"/*/; do
    [ -d "$profile" ] || continue
    ini="$profile/basic.ini"
    [ -f "$ini" ] || printf '[SimpleOutput]\n' > "$ini"
    # Simple output path — modern OBS with hybrid output (RecFormat2) resolves
    # the record directory from [SimpleOutput] FilePath, not RecFilePath.
    pin_section_key "SimpleOutput" "RecFilePath" "$RECORDING_DIR" "$ini"
    pin_section_key "SimpleOutput" "FilePath" "$RECORDING_DIR" "$ini"
    # Advance-output path (drifts to ~ if ever present and left unpinned).
    pin_section_key "AdvOut" "RecFilePath" "$RECORDING_DIR" "$ini"
    pin_section_key "AdvOut" "FFFilePath" "$RECORDING_DIR" "$ini"
    pinned=$((pinned + 1))
done

echo "pinned RecFilePath=$RECORDING_DIR across $pinned profile(s)"
exit 0
