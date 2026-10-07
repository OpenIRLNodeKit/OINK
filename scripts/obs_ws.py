# SPDX-FileCopyrightText: 2026 OpenIRLNodeKit contributors
# SPDX-License-Identifier: AGPL-3.0-or-later
"""Shared obs-websocket v5 client for the OpenIRLNodeKit host-setup scripts.

This module is a pure, importable bridge over the loopback obs-websocket. The
host-setup phase (``scripts/sections.py`` §6c verification) uses it to talk to
OBS without shelling out to a helper script.

``scripts/templates/scenes.py`` (deployed to the host as
``/usr/local/libexec/oink/oink-scenes.py``) is a **self-contained mirror** of this module:
it must run standalone on a deployed host that has no repo checkout. Keep the
two in sync if the auth/handshake flow changes — the duplication here is
deliberate and constrained by deployment, not by oversight.
"""

from __future__ import annotations

import base64
import hashlib
import json

from constants import OBS_WS_PORT, OBS_WS_TIMEOUT

WS_HOST = "127.0.0.1"

OP_IDENTIFY = 1
OP_REQUEST = 6
OP_REQUEST_RESPONSE = 7

# Socket timeout for connect + receive. Uses the shared OBS_WS_TIMEOUT so the
# value is configurable from one place rather than a hardcoded literal.
DEFAULT_TIMEOUT = OBS_WS_TIMEOUT


def sha256_b64(s: bytes) -> str:
    """obs-websocket auth helper: Base64(SHA256(s))."""
    return base64.b64encode(hashlib.sha256(s).digest()).decode("ascii")


def build_identify(password: str, hello: dict) -> dict:
    """Build the op:1 identify payload for the received op:0 hello frame.

    When the server advertises a challenge+salt, the authentication string is
    Base64(SHA256(Base64(SHA256(password + salt)) + challenge)) — note the
    **password + salt** ordering required by obs-websocket.
    """
    d = hello.get("d", {})
    auth = d.get("authentication") or {}
    challenge = auth.get("challenge")
    salt = auth.get("salt")
    identify = {"rpcVersion": 1}
    if challenge and salt:
        secret = sha256_b64((password + salt).encode("utf-8"))
        auth_string = sha256_b64((secret + challenge).encode("utf-8"))
        identify["authentication"] = auth_string
    return identify


def connect(password: str, timeout: float = DEFAULT_TIMEOUT):
    """Open an obs-websocket session and await the server's Identified frame.

    Returns the open websocket once the handshake completes. Raises if the
    connection or the identify exchange fails.
    """
    import websocket  # python3-websocket (installed by the §1 apt pass)

    ws = websocket.create_connection(
        f"ws://{WS_HOST}:{OBS_WS_PORT}", timeout=timeout, subprotocols=["obswebsocket.json"])
    hello = json.loads(ws.recv())
    ws.send(json.dumps({"op": OP_IDENTIFY, "d": build_identify(password, hello)}))
    while True:
        msg = json.loads(ws.recv())
        if msg.get("op") == 2 and msg.get("d", {}).get("negotiatedRpcVersion") is not None:
            return ws


def request(ws, request_type: str, data: dict, state: dict) -> dict:
    """Send one obs-websocket request and return the matching response dict.

    ``state`` is a caller-held ``{"seq": int}`` dict that supplies/advances the
    request id, so sequences of requests stay unambiguous.
    """
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
