// SPDX-FileCopyrightText: 2026 OpenIRLNodeKit contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
import AssetManager from "../components/islands/AssetManager";

export default function Assets() {
  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-2xl font-semibold tracking-tight">Assets</h2>
        <p className="mt-0.5 text-sm text-text-secondary">
          Drop OBS images, media, sound files, etc here.
        </p>
      </div>

      <AssetManager />
    </div>
  );
}
