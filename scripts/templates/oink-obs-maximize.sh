#!/bin/bash
# SPDX-FileCopyrightText: 2026 OpenIRLNodeKit contributors
# SPDX-License-Identifier: AGPL-3.0-or-later
# Wait for OBS main window and maximize it to fill the virtual display
for i in {1..60}; do
    WIN=$(DISPLAY=:99 xdotool search --name "OBS.*Profile:" 2>/dev/null | head -1)
    if [ -n "$WIN" ]; then
        DISPLAY=:99 xdotool windowsize "$WIN" 100% 100%
        DISPLAY=:99 xdotool windowmove "$WIN" 0 0
        exit 0
    fi
    sleep 1
done
exit 1
