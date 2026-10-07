// SPDX-FileCopyrightText: 2026 OpenIRLNodeKit contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
import Tabs from "../components/islands/Tabs";

export default function Advanced() {
  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-2xl font-semibold tracking-tight">Advanced</h2>
          <p className="mt-0.5 text-sm text-text-secondary">
            Live logs, service controls, and config editing.
          </p>
        </div>
        <a
          href="https://github.com/OpenIRLNodeKit/OINK/issues/new"
          target="_blank"
          rel="noopener"
          className="inline-flex items-center gap-1.5 rounded-control bg-bg-card px-3.5 py-2 text-sm font-medium text-text-primary ring-1 ring-inset ring-border-subtle transition-colors hover:bg-bg-elevated hover:ring-border"
        >
          Report Issue
        </a>
      </div>

      <Tabs />
    </div>
  );
}
