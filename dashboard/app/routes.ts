// SPDX-FileCopyrightText: 2026 OpenIRLNodeKit contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  type RouteConfig,
  index,
  layout,
  route,
} from "@react-router/dev/routes";

export default [
  layout("routes/public.tsx", [
    index("routes/index.tsx"),
    route("change-password", "routes/change-password.tsx"),
  ]),
  layout("routes/auth.tsx", [
    route("dashboard", "routes/dashboard.tsx"),
    route("settings", "routes/settings.tsx"),
    route("overlays", "routes/overlays.tsx"),
    route("ingest", "routes/ingest.tsx"),
    route("assets", "routes/assets.tsx"),
    route("recordings", "routes/recordings.tsx"),
    route("advanced", "routes/advanced.tsx"),
  ]),
  route("preview", "routes/preview.tsx"),
  route("welcome", "routes/welcome.tsx"),
] satisfies RouteConfig;
