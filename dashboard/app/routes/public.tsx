// SPDX-FileCopyrightText: 2026 OpenIRLNodeKit contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
import { Outlet } from "react-router";
import ThemeToggle from "../components/ThemeToggle";

export default function PublicLayout() {
  return (
    <>
      <ThemeToggle className="fixed right-4 top-4 z-20" />
      <Outlet />
    </>
  );
}
