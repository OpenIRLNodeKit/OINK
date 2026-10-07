# SPDX-FileCopyrightText: 2026 OpenIRLNodeKit contributors
# SPDX-License-Identifier: AGPL-3.0-or-later
"""Unit tests for scripts/obs_ws.py — the shared obs-websocket v5 client."""

from __future__ import annotations

import json
import sys
import types

import obs_ws
from obs_ws import build_identify, connect, request, sha256_b64


def _patch_ws(monkeypatch, factory):
    """obs_ws imports websocket lazily; inject a fake module into sys.modules."""
    monkeypatch.setitem(sys.modules, "websocket", types.SimpleNamespace(create_connection=factory))


class _FakeWS:
    """Minimal websocket stand-in: recv() pops queued frames, send() records."""

    def __init__(self, frames):
        self.frames = list(frames)
        self.sent = []

    def recv(self):
        if not self.frames:
            raise Exception("no more frames")
        return self.frames.pop(0)

    def send(self, payload):
        self.sent.append(payload)

    def close(self):
        pass


def _hello(challenge="ch", salt="SALT"):
    return json.dumps({"op": 0, "d": {"authentication": {"challenge": challenge, "salt": salt}}})


def _identified():
    return json.dumps({"op": 2, "d": {"negotiatedRpcVersion": 1}})


# ── sha256_b64 / build_identify ───────────────────────────────────────────────

def test_sha256_b64_matches_known_value():
    assert sha256_b64(b"") == "47DEQpj8HBSa+/TImW+5JCeuQeRkm5NMpJWZG3hSuFU="


def test_build_identify_sets_authentication():
    hello = json.loads(_hello("challenge", "salt"))
    identify = build_identify("pw", hello)
    assert identify["rpcVersion"] == 1
    # password+salt order, then secret+challenge.
    secret = sha256_b64(("pw" + "salt").encode())
    expected = sha256_b64((secret + "challenge").encode())
    assert identify["authentication"] == expected


def test_build_identify_without_challenge_omits_auth():
    hello = {"d": {}}
    identify = build_identify("pw", hello)
    assert identify == {"rpcVersion": 1}
    assert "authentication" not in identify


# ── connect ───────────────────────────────────────────────────────────────────

def test_connect_identifies_and_returns_socket(monkeypatch):
    hello = _hello("challenge", "salt")
    ws = _FakeWS([hello, _identified()])
    _patch_ws(monkeypatch, lambda *a, **k: ws)

    conn = connect("pw", timeout=5)

    assert conn is ws
    # A single op:1 identify frame was sent.
    assert len(ws.sent) == 1
    sent = json.loads(ws.sent[0])
    assert sent["op"] == 1
    assert sent["d"]["rpcVersion"] == 1
    assert sent["d"]["authentication"]  # auth string present


def test_connect_requests_subprotocol(monkeypatch):
    hello = _hello()
    ws = _FakeWS([hello, _identified()])
    seen = {}

    def _factory(url, timeout=None, subprotocols=None):
        seen["url"] = url
        seen["timeout"] = timeout
        seen["subprotocols"] = subprotocols
        return ws

    _patch_ws(monkeypatch, _factory)
    connect("pw")
    assert seen["url"] == "ws://127.0.0.1:4455"
    assert seen["subprotocols"] == ["obswebsocket.json"]
    assert seen["timeout"] == obs_ws.DEFAULT_TIMEOUT


# ── request ───────────────────────────────────────────────────────────────────

def test_request_sends_op6_and_returns_matching_op7(monkeypatch):
    ws = _FakeWS([
        json.dumps({"op": 7, "d": {"requestId": "GetSceneList-0", "responseData": {"scenes": []}}}),
    ])
    state = {"seq": 0}

    resp = request(ws, "GetSceneList", {}, state)

    assert state["seq"] == 1
    sent = json.loads(ws.sent[0])
    assert sent["op"] == 6
    assert sent["d"]["requestType"] == "GetSceneList"
    assert sent["d"]["requestId"] == "GetSceneList-0"
    assert resp["requestId"] == "GetSceneList-0"
    assert resp["responseData"] == {"scenes": []}


def test_request_skips_unrelated_frames(monkeypatch):
    # A vendor event (op5) precedes the matching response; the client must skip it.
    ws = _FakeWS([
        json.dumps({"op": 5, "d": {"eventType": "SomeEvent"}}),
        json.dumps({"op": 7, "d": {"requestId": "CallVendorRequest-0"}}),
    ])
    state = {"seq": 0}

    resp = request(ws, "CallVendorRequest", {"vendorName": "x"}, state)

    assert state["seq"] == 1
    assert resp["requestId"] == "CallVendorRequest-0"
