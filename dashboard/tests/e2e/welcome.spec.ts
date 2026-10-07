// SPDX-FileCopyrightText: 2026 OpenIRLNodeKit contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
import { expect, test, type Page } from '@playwright/test';

/**
 * First-run welcome screen. Direct /welcome against mocked /api/settings and
 * the OBS state endpoints (StreamKeysForm + StreamQualityForm read live state).
 */

async function addMocks(page: Page) {
  await page.route('**/api/auth/status', (route) =>
    route.fulfill({ json: { ok: false, enabled: false, user: null } }),
  );
  let stored = { welcomeComplete: false, twitchChannel: '' };
  await page.route('**/api/settings', async (route) => {
    if (route.request().method() === 'PUT') {
      const body = route.request().postDataJSON() as {
        welcomeComplete?: boolean;
        twitchChannel?: string;
      };
      if (typeof body.welcomeComplete === 'boolean') stored.welcomeComplete = body.welcomeComplete;
      if (typeof body.twitchChannel === 'string') stored.twitchChannel = body.twitchChannel;
    }
    await route.fulfill({ json: { ok: true, presetProvided: false, ...stored } });
  });
  await page.route('**/api/obs/stream-service', (route) =>
    route.fulfill({
      json: { ok: true, platform: 'twitch', service: 'Twitch', server: '', key: '', keyLast4: null },
    }),
  );
  await page.route('**/api/obs/primary-platform', (route) =>
    route.fulfill({ json: { ok: true, platform: 'twitch' } }),
  );
  await page.route('**/api/obs/multistream/keys', (route) =>
    route.fulfill({ json: { ok: true, platforms: {}, primaryPlatform: 'twitch' } }),
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
}

test.describe('welcome screen', () => {
  test('shows the missing setup sections', async ({ page }) => {
    await addMocks(page);
    await page.goto('/welcome');

    await expect(page.getByRole('heading', { name: 'Welcome to OINK' })).toBeVisible();
    await expect(page.getByLabel('Twitch channel name')).toBeVisible();
    await expect(page.getByLabel('Resolution')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Finish setup' })).toBeVisible();
  });

  test('skipping marks the welcome complete and lands on the dashboard', async ({ page }) => {
    await addMocks(page);
    await page.goto('/welcome');
    await page.getByRole('button', { name: 'Skip for now' }).click();
    await expect(page).toHaveURL(/\/dashboard/);
  });
});
