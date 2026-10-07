// SPDX-FileCopyrightText: 2026 OpenIRLNodeKit contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
import { test, expect, type Page } from '@playwright/test';

/**
 * Service-control toggle against mocked /api/* routes (see log-server.js for the real
 * contract: status -> { ok, running }, start/stop/restart -> { ok, message }).
 */

async function mockService(page: Page, service: string, { running }: { running: boolean }) {
  let current = running;

  await page.route(`**/api/service/${service}/status`, (route) => {
    route.fulfill({ json: { ok: true, running: current } });
  });
  await page.route(`**/api/service/${service}/start`, (route) => {
    current = true;
    route.fulfill({ json: { ok: true, message: `${service} started` } });
  });
  await page.route(`**/api/service/${service}/stop`, (route) => {
    current = false;
    route.fulfill({ json: { ok: true, message: `${service} stopped` } });
  });
}

test.describe('service control', () => {
  test('starts a stopped service and the button flips to Stop', async ({ page }) => {
    await mockService(page, 'mediamtx', { running: false });

    await page.goto('/advanced');

    const startBtn = page.getByRole('button', { name: 'Start', exact: true });
    await expect(startBtn).toBeVisible();
    await startBtn.click();

    // ServiceControl re-polls status after the action; running now true -> Stop shown.
    await expect(page.getByRole('button', { name: 'Stop', exact: true })).toBeVisible();
  });

  test('stops a running service and the button flips to Start', async ({ page }) => {
    await mockService(page, 'mediamtx', { running: true });

    await page.goto('/advanced');

    const stopBtn = page.getByRole('button', { name: 'Stop', exact: true });
    await expect(stopBtn).toBeVisible();
    await stopBtn.click();

    await expect(page.getByRole('button', { name: 'Start', exact: true })).toBeVisible();
  });

  test('config editor opens and shows server content', async ({ page }) => {
    await mockService(page, 'noalbs', { running: true });
    await page.route('**/api/config/noalbs', (route) =>
      route.fulfill({ json: { ok: true, content: 'noalbs: {}\n', file: 'config.json' } }),
    );

    await page.goto('/advanced');
    await page.getByRole('button', { name: 'NOALBS' }).click();

    await expect(page.getByRole('button', { name: 'Stop', exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Edit Config' }).click();

    await expect(page.getByRole('heading', { name: 'Edit NOALBS Config' })).toBeVisible();
    await expect(page.getByText('noalbs: {}')).toBeVisible();
  });

  test('obs service control starts a stopped OBS and flips to Stop', async ({ page }) => {
    await mockService(page, 'obs', { running: false });

    await page.goto('/advanced');
    await page.getByRole('button', { name: 'OBS' }).click();

    const startBtn = page.getByRole('button', { name: 'Start', exact: true });
    await expect(startBtn).toBeVisible();
    await startBtn.click();

    await expect(page.getByRole('button', { name: 'Stop', exact: true })).toBeVisible();
  });

  test('obs service control stops a running OBS and flips to Start', async ({ page }) => {
    await mockService(page, 'obs', { running: true });

    await page.goto('/advanced');
    await page.getByRole('button', { name: 'OBS' }).click();

    const stopBtn = page.getByRole('button', { name: 'Stop', exact: true });
    await expect(stopBtn).toBeVisible();
    await stopBtn.click();

    await expect(page.getByRole('button', { name: 'Start', exact: true })).toBeVisible();
  });
});
