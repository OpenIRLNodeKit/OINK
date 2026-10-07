// SPDX-FileCopyrightText: 2026 OpenIRLNodeKit contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
import SettingsTabs from "../components/islands/SettingsTabs";

export default function Settings() {
  return (
    <div className="max-w-2xl space-y-6">
      <div>
        <h2 className="text-2xl font-semibold tracking-tight">Settings</h2>
        <p className="mt-0.5 text-sm text-text-secondary">
          Appearance, accounts, encoder behavior, and preview preferences.
        </p>
      </div>

      <SettingsTabs />
    </div>
  );
}
