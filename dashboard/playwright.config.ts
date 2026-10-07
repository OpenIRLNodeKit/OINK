// SPDX-FileCopyrightText: 2026 OpenIRLNodeKit contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
import { defineConfig } from '@playwright/test';

/**
 * E2E smoke tests for the OINK dashboard.
 *
 * Runs against the statically-built SPA served by e2e-server.mjs (no live VM/stack
 * needed): every /api/* call is stubbed at the Playwright route layer, so these specs
 * pass without the log-server, the oink-* services, or guacd running anywhere.
 */
export default defineConfig({
  testDir: './tests/e2e',
  timeout: 30_000,
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 2 : 0,
  reporter: process.env.CI
    ? [['list'], ['html', { open: 'never' }]]
    : 'list',
  use: {
    baseURL: 'http://127.0.0.1:4399',
    trace: 'retain-on-failure',
  },
  projects: [{ name: 'chromium', use: { browserName: 'chromium' } }],
  webServer: {
    command: 'npm run build && node e2e-server.mjs 4399',
    url: 'http://127.0.0.1:4399',
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
});
