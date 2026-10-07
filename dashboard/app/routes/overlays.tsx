// SPDX-FileCopyrightText: 2026 OpenIRLNodeKit contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
import OverlayTabs from "../components/islands/OverlayTabs";

export default function Overlays() {
  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-2xl font-semibold tracking-tight">Overlays</h2>
        <p className="mt-0.5 text-sm text-text-secondary">
          Generate OBS Browser Source URLs for your overlays and add them to
          your scenes.
        </p>
      </div>

      <OverlayTabs />
    </div>
  );
}
