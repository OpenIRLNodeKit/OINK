# SPDX-FileCopyrightText: 2026 OpenIRLNodeKit contributors
# SPDX-License-Identifier: AGPL-3.0-or-later
"""Unit tests for scripts/cleanup.py — helper/unit inventory (no legacy residue)."""

from __future__ import annotations

import cleanup


def test_bin_scripts_are_exact_current_set():
    assert cleanup.BIN_SCRIPTS == ["/usr/local/bin/oink"]


def test_systemd_units_include_stack_units():
    assert cleanup.SYSTEMD_UNITS == [
        "oink-display", "oink-obs", "oink-firewall", "oink-vnc", "oink-guac",
        "oink-nginx", "oink-mediamtx", "oink-srtla", "oink-noalbs", "oink-api",
    ]


def test_no_legacy_artifacts_remain():
    # Pre-rename helper alias, container-residue cleanup lists, legacy polkit
    # rule, and the iptables-legacy revert helper were all removed.
    assert not hasattr(cleanup, "COMPOSE_CONTAINERS")
    assert not hasattr(cleanup, "STANDALONE_CONTAINERS")
    assert not hasattr(cleanup, "IMAGES")
    assert not hasattr(cleanup, "POLKIT_RULE_LEGACY")
    assert not hasattr(cleanup, "_iptables_is_legacy")
