// SPDX-FileCopyrightText: 2026 OpenIRLNodeKit contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
import RecordingsManager from "../components/islands/RecordingsManager";

export default function Recordings() {
  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-2xl font-semibold tracking-tight">Recordings</h2>
        <p className="mt-0.5 text-sm text-text-secondary">
          Videos recorded by OBS on this server — play them back, download, or
          delete. New recordings appear automatically.
        </p>
      </div>

      <RecordingsManager />
    </div>
  );
}
