// SPDX-FileCopyrightText: 2026 OpenIRLNodeKit contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
import { expect, type Page, test } from '@playwright/test';

/**
 * Stream key management on /settings against mocked /api/* routes. The ingest
 * key lives under Settings → General → Stream Settings (see log-server.js for
 * the real contract: GET /api/ingest, POST /api/ingest/rotate).
 */

const KEY = 'SecretKey_123456789012345';

async function mockSettings(page: Page) {
  await page.route('**/api/auth/status', (route) =>
    route.fulfill({ json: { ok: false, enabled: false, user: null } }),
  );

  await page.route('**/api/obs/stream-settings', (route) =>
    route.fulfill({
      json: {
        ok: true,
        encoder: 'x264',
        outputWidth: 1920,
        outputHeight: 1080,
        fpsNumerator: 60,
        fpsDenominator: 1,
        bitrate: 6000,
        hasNvenc: false,
        streamActive: false,
      },
    }),
  );

  await page.route('**/api/ingest', async (route) => {
    if (route.request().method() === 'GET') {
      await route.fulfill({
        json: {
          ok: true,
          key: KEY,
          defaultPath: `live/${KEY}/stream`,
          createdAt: 1,
          updatedAt: 1,
        },
      });
    } else {
      await route.fulfill({
        status: 404,
        json: { ok: false, error: 'not found' },
      });
    }
  });

  await page.route('**/api/ingest/rotate', (route) =>
    route.fulfill({
      json: {
        ok: true,
        key: 'Rotated_abcdefghijklmnopqrs',
        defaultPath: 'live/Rotated_abcdefghijklmnopqrs/stream',
        createdAt: 1,
        updatedAt: 2,
      },
    }),
  );
}

test.describe('ingest key (Settings)', () => {
  test('shows the key blurred, revealing it on View', async ({ page }) => {
    await mockSettings(page);
    await page.goto('/settings');

    const keyField = page.getByLabel('Ingest key').first();
    await expect(keyField).toHaveValue(KEY);
    await expect(keyField).toHaveAttribute('data-blurred', 'true');

    await page.getByRole('button', { name: 'View' }).click();
    await expect(page.getByLabel('Ingest key').first()).not.toHaveAttribute(
      'data-blurred',
      'true',
    );
  });

  test('rotates the key after a confirm step', async ({ page }) => {
    await mockSettings(page);
    await page.goto('/settings');

    const keyField = page.getByLabel('Ingest key').first();
    await expect(keyField).toHaveValue(KEY);
    await page.getByRole('button', { name: 'Rotate ingest key' }).click();
    await page.getByRole('button', { name: /Confirm rotate/ }).click();

    await expect(keyField).toHaveValue(
      'Rotated_abcdefghijklmnopqrs',
    );
  });
});
