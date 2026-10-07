#!/bin/sh
# SPDX-FileCopyrightText: 2026 OpenIRLNodeKit contributors
# SPDX-License-Identifier: AGPL-3.0-or-later
#
# OpenIRLNodeKit loopback-only port guard.
#
# Two services cannot be confined to loopback by their own bind options:
#   * obs-websocket (4455) has no bind-address option and listens on 0.0.0.0.
#   * x11vnc's `-listen 127.0.0.1` still opens an IPv6 wildcard listener on 5900.
# The control-plane API (loopback) is the only client of obs-websocket, and
# guacd reaches VNC natively on the host loopback, so drop inbound on these
# ports from anything other than the loopback interface. The `inet` family
# covers IPv4 and IPv6 in one table. Idempotent: the table is recreated on
# every run.
set -eu

TABLE=oink
PORTS="4455 5900"

if nft list table inet "$TABLE" >/dev/null 2>&1; then
    nft delete table inet "$TABLE"
fi
nft add table inet "$TABLE"
nft add chain inet "$TABLE" input '{ type filter hook input priority -150 ; policy accept ; }'
for port in $PORTS; do
    nft add rule inet "$TABLE" input iifname != "lo" tcp dport "$port" drop
done
