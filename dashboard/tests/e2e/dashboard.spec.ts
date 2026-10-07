// SPDX-FileCopyrightText: 2026 OpenIRLNodeKit contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
import { test, expect } from '@playwright/test';

/**
 * Smoke tests: key pages render. No /api/* is hit on these pages (the preview
 * MJPEG stream is served same-origin through nginx in production and is not
 * running in e2e — the <img> element and the surrounding page still mount,
 * which is what we assert).
 */
test.describe('page smoke tests', () => {
  test('dashboard renders core sections', async ({ page }) => {
    await page.goto('/dashboard');

    await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'OBS Output Monitor' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Scenes' })).toBeVisible();

    // PreviewFrame mounts the OBS virtual-camera preview image.
    await expect(page.locator('img[alt="OBS Preview"]')).toBeVisible();
  });

  test('preview page renders PreviewFrame', async ({ page }) => {
    await page.goto('/preview');

    await expect(page.getByRole('heading', { name: 'Preview Projector' })).toBeVisible();
    await expect(page.locator('img[alt="OBS Preview Canvas"]')).toBeVisible();
  });

  test('root renders the auth form', async ({ page }) => {
    await page.goto('/');

    await expect(page.getByLabel('Password')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Sign In' })).toBeVisible();
  });
});
