#!/usr/bin/env python3
# SPDX-FileCopyrightText: 2026 OpenIRLNodeKit contributors
# SPDX-License-Identifier: AGPL-3.0-or-later
"""oink-scenes.py — ensure the default OBS scenes exist and are active.

Idempotent. Connects to the local obs-websocket (ws://127.0.0.1:4455), reads the
password from the host-setup-generated password file, creates any of the default
scenes that are missing and forces the "main" scene as the current
program scene (switching back if the operator changed away).

Usage:
    oink-scenes.py [password_file] [--scenes main brb privacy offline low-br] [--current main]

Default password_file: $HOME/.config/obs-studio/plugin_config/obs-websocket/password
"""

from __future__ import annotations

import argparse
import base64
import hashlib
import json
import pathlib
import sys

try:
    import websocket  # python3-websocket (websocket-client)
except ImportError as e:
    print(f"error: python websocket-client is required: {e}", file=sys.stderr)
    sys.exit(1)


WS_URL = "ws://127.0.0.1:4455"

DEFAULT_SCENES = ["main", "brb", "privacy", "offline", "low-br"]
DEFAULT_CURRENT = "main"

# OBS ships 1280x720 with its own bitrate; the node's default is the dashboard's
# 1080p30 preset. setup converges the active profile onto it (idempotent) so the
# 1080p30 preset shows as active in /settings without a manual visit.
PRESET_VIDEO = (1920, 1080, 30, 6000)
DEFAULT_VIDEO = {
    "baseWidth": 1920,
    "baseHeight": 1080,
    "outputWidth": 1920,
    "outputHeight": 1080,
    "fpsNumerator": 30,
    "fpsDenominator": 1,
}

OP_IDENTIFY = 1
OP_REQUEST = 6
OP_REQUEST_RESPONSE = 7


def sha256_b64(s: bytes) -> str:
    return base64.b64encode(hashlib.sha256(s).digest()).decode("ascii")


def build_identify(password: str, hello: dict) -> dict:
    d = hello.get("d", {})
    auth = d.get("authentication") or {}
    challenge = auth.get("challenge")
    salt = auth.get("salt")
    identify = {"rpcVersion": 1}
    if challenge and salt:
        # obs-websocket: Base64(SHA256(password + salt)), then
        # Base64(SHA256(that + challenge)) as the authentication string.
        secret = sha256_b64((password + salt).encode("utf-8"))
        auth_string = sha256_b64((secret + challenge).encode("utf-8"))
        identify["authentication"] = auth_string
    return identify


def connect(password: str):
    ws = websocket.create_connection(WS_URL, timeout=10, subprotocols=["obswebsocket.json"])
    hello = json.loads(ws.recv())
    ws.send(json.dumps({"op": OP_IDENTIFY, "d": build_identify(password, hello)}))
    # Wait for the server's "Identified" (op 2) before sending any requests —
    # OBS rejects/bounces a request that races its identify processing.
    while True:
        msg = json.loads(ws.recv())
        if msg.get("op") == 2 and msg.get("d", {}).get("negotiatedRpcVersion") is not None:
            return ws


def request(ws, request_type: str, data: dict, state: dict) -> str:
    req_id = f"{request_type}-{state['seq']}"
    state["seq"] += 1
    ws.send(json.dumps({"op": OP_REQUEST, "d": {
        "requestType": request_type,
        "requestId": req_id,
        "requestData": data,
    }}))
    while True:
        msg = json.loads(ws.recv())
        d = msg.get("d", {})
        if msg.get("op") == OP_REQUEST_RESPONSE and d.get("requestId") == req_id:
            return d


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__,
        formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("password_file", nargs="?",
        default=str(pathlib.Path.home()
                    / ".config/obs-studio/plugin_config/obs-websocket/password"))
    ap.add_argument("--scenes", nargs="+", default=DEFAULT_SCENES,
                    help="scene names to ensure exist (default: %(default)s)")
    ap.add_argument("--current", default=DEFAULT_CURRENT,
                    help="scene name to set as current program scene (default: %(default)s)")
    ap.add_argument("--recording-dir", default=None,
                    help="pin the OBS simple-output recording directory (RecFilePath)")
    args = ap.parse_args()

    pfile = pathlib.Path(args.password_file)
    pw = pfile.read_text().strip() if pfile.exists() else ""
    if not pw:
        print(f"error: cannot read OBS websocket password from {pfile}", file=sys.stderr)
        sys.exit(1)

    print(f"connecting to {WS_URL}…")
    ws = connect(pw)
    state = {"seq": 0}

    resp = request(ws, "GetSceneList", {}, state)
    existing = {s.get("sceneName") for s in resp.get("responseData", {}).get("scenes", [])}
    status = resp.get("requestStatus", {})
    if status.get("code") not in (100, 104) and not existing:
        print(f"error: GetSceneList failed: {status}", file=sys.stderr)
        sys.exit(1)

    missing = [s for s in args.scenes if s not in existing]
    if missing:
        print(f"creating missing scenes: {', '.join(missing)}")
        for name in missing:
            resp = request(ws, "CreateScene", {"sceneName": name}, state)
            code = resp.get("requestStatus", {}).get("code")
            if code not in (100, 104):
                print(f"warning: CreateScene({name}) failed: {resp.get('requestStatus')}",
                      file=sys.stderr)
    else:
        print("all scenes already exist")

    print(f"setting current program scene: {args.current}")
    resp = request(ws, "SetCurrentProgramScene", {"sceneName": args.current}, state)
    code = resp.get("requestStatus", {}).get("code")
    if code != 100:
        print(f"error: SetCurrentProgramScene failed: {resp.get('requestStatus')}",
              file=sys.stderr)
        sys.exit(1)

    # Converge the active profile onto the dashboard's 1080p30 preset (resolution
    # + fps + bitrate) so /settings highlights it without a manual visit. No-op
    # when already on the preset; leaves the encoder choice alone.
    resp = request(ws, "GetVideoSettings", {}, state)
    if resp.get("requestStatus", {}).get("code") != 100:
        print(f"warning: GetVideoSettings failed: {resp.get('requestStatus')}",
              file=sys.stderr)
    else:
        video = resp.get("responseData", {})
        denom = video.get("fpsDenominator") or 1
        bitrate = request(ws, "GetProfileParameter", {
            "parameterCategory": "SimpleOutput",
            "parameterName": "VBitrate",
        }, state).get("responseData", {}).get("parameterValue")
        current = (
            video.get("outputWidth"),
            video.get("outputHeight"),
            round(video.get("fpsNumerator", 0) / denom),
            int(bitrate or 0),
        )
        if current == PRESET_VIDEO:
            print("stream output already 1080p30")
        else:
            print(f"setting stream output to 1080p30 "
                  f"(was {current[0]}x{current[1]}@{current[2]}, {current[3]}kbps)")
            for request_type, data in (
                ("SetVideoSettings", DEFAULT_VIDEO),
                # Keep OBS's FPS dropdown on "30" (Common), not integer/fractional.
                ("SetProfileParameter", {"parameterCategory": "Video",
                                         "parameterName": "FPSType", "parameterValue": "0"}),
                ("SetProfileParameter", {"parameterCategory": "Video",
                                         "parameterName": "FPSCommon", "parameterValue": "30"}),
                ("SetProfileParameter", {"parameterCategory": "SimpleOutput",
                                         "parameterName": "VBitrate", "parameterValue": "6000"}),
            ):
                resp = request(ws, request_type, data, state)
                if resp.get("requestStatus", {}).get("code") != 100:
                    print(f"warning: {request_type} failed: {resp.get('requestStatus')}",
                          file=sys.stderr)

    # Pin the simple-output recording directory so recordings land in a known,
    # monitored location (default: the runtime user's ~/recordings).
    if args.recording_dir:
        print(f"pinning recording directory: {args.recording_dir}")
        resp = request(ws, "SetProfileParameter", {
            "parameterCategory": "SimpleOutput",
            "parameterName": "RecFilePath",
            "parameterValue": args.recording_dir,
        }, state)
        code = resp.get("requestStatus", {}).get("code")
        if code != 100:
            print(f"warning: SetProfileParameter(RecFilePath) failed: {resp.get('requestStatus')}",
                  file=sys.stderr)

    ws.close()
    print("done")


if __name__ == "__main__":
    main()
