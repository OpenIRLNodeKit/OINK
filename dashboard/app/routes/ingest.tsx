// SPDX-FileCopyrightText: 2026 OpenIRLNodeKit contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
import IngestManager from "../components/islands/IngestManager";

export default function Ingest() {
  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-2xl font-semibold tracking-tight">Ingest</h2>
        <p className="mt-0.5 text-sm text-text-secondary">
          Scan the QR code with your phone camera to import the server into your
          streaming app.
        </p>
      </div>

      <IngestManager />
    </div>
  );
}
