// SPDX-FileCopyrightText: 2026 OpenIRLNodeKit contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  isRouteErrorResponse,
  Links,
  Meta,
  Outlet,
  Scripts,
  ScrollRestoration,
} from "react-router";

import type { Route } from "./+types/root";
import "./styles/global.css";
import { DEFAULT_THEME, themes } from "./utils/theme";

const THEME_SCRIPT = `
(function() {
  var stored = localStorage.getItem('oink-theme');
  var validThemes = ${JSON.stringify(themes.map((t) => t.id))};
  if (stored && validThemes.indexOf(stored) !== -1) {
    document.documentElement.setAttribute('data-theme', stored);
  } else {
    document.documentElement.setAttribute('data-theme', '${DEFAULT_THEME}');
  }
})();
`;

export const links: Route.LinksFunction = () => [
  { rel: "icon", href: "/favicon.ico", sizes: "any" },
  { rel: "icon", type: "image/png", href: "/branding/oink-icon-black.png" },
  { rel: "icon", type: "image/png", media: "(prefers-color-scheme: dark)", href: "/branding/oink-icon-white.png" },
];

export function Layout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <Meta />
        <Links />
        <script dangerouslySetInnerHTML={{ __html: THEME_SCRIPT }} />
      </head>
      <body className="min-h-screen bg-bg-dark text-text-primary">
        {children}
        <ScrollRestoration />
        <Scripts />
      </body>
    </html>
  );
}

export function HydrateFallback() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-bg-dark">
      <div className="h-12 w-12 border-2 border-primary border-t-transparent rounded-full animate-spin" />
    </div>
  );
}

export default function App() {
  return <Outlet />;
}

export function ErrorBoundary({ error }: Route.ErrorBoundaryProps) {
  let message = "Oops!";
  let details = "An unexpected error occurred.";

  if (isRouteErrorResponse(error)) {
    message = error.status === 404 ? "404" : "Error";
    details =
      error.status === 404
        ? "The requested page could not be found."
        : error.statusText || details;
  } else if (import.meta.env.DEV && error && error instanceof Error) {
    details = error.message;
  }

  return (
    <main className="min-h-screen bg-bg-dark text-text-primary pt-16 p-4">
      <h1 className="text-2xl font-semibold tracking-tight">{message}</h1>
      <p className="mt-2 text-text-secondary">{details}</p>
    </main>
  );
}
