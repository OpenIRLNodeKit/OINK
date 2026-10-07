// SPDX-FileCopyrightText: 2026 OpenIRLNodeKit contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
import PreviewFrame from "../components/islands/PreviewFrame";
import { Sidebar } from "../components/Sidebar";
import { Header } from "../components/Header";

export default function Preview() {
  return (
    <div className="flex h-screen overflow-hidden">
      <Sidebar activePage="preview" />
      <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
        <Header title="Preview" />
        <main className="flex min-h-0 flex-1 flex-col gap-3 p-4">
          <div>
            <h2 className="text-2xl font-semibold tracking-tight">Preview Projector</h2>
            <p className="mt-0.5 text-sm text-text-secondary">
              OBS canvas, captured from the virtual camera.
            </p>
          </div>
          <div className="surface min-h-0 flex-1 p-4">
            <PreviewFrame
              title="OBS Preview Canvas"
              wrapperClass="relative h-full w-full overflow-hidden rounded-control bg-black ring-1 ring-inset ring-border-subtle"
            />
          </div>
        </main>
      </div>
    </div>
  );
}
