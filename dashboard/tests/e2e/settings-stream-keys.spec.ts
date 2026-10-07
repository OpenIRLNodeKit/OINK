// SPDX-FileCopyrightText: 2026 OpenIRLNodeKit contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
import { expect, type Page, test } from '@playwright/test';

/**
 * Stream keys management on /settings against mocked /api/* routes.
 * Tests the unified StreamKeysForm component.
 */

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

  await page.route('**/api/obs/primary-platform', async (route) => {
    if (route.request().method() === 'GET') {
      await route.fulfill({
        json: { ok: true, platform: 'twitch' },
      });
    } else {
      await route.fulfill({
        json: { ok: true, restartRequired: true },
      });
    }
  });

  await page.route('**/api/obs/stream-service', async (route) => {
    if (route.request().method() === 'GET') {
      await route.fulfill({
        json: {
          ok: true,
          platform: 'twitch',
          service: 'Twitch',
          server: 'rtmp://live.twitch.tv/app',
          key: '',
          keyLast4: null,
        },
      });
    } else {
      await route.fulfill({
        json: {
          ok: true,
          restartRequired: true,
          platform: 'twitch',
          service: 'Twitch',
          server: 'rtmp://live.twitch.tv/app',
          key: '',
          keyLast4: '1234',
        },
      });
    }
  });

  await page.route('**/api/obs/multistream/keys', async (route) => {
    if (route.request().method() === 'GET') {
      await route.fulfill({
        json: {
          ok: true,
          primaryPlatform: 'twitch',
          platforms: {
            kick: { configured: false, last4: null },
            youtube: { configured: true, last4: '5678' },
          },
        },
      });
    } else {
      await route.fulfill({
        json: {
          ok: true,
          restartRequired: true,
          primaryPlatform: 'twitch',
          platforms: {
            kick: { configured: true, last4: 'abcd' },
            youtube: { configured: true, last4: '5678' },
          },
        },
      });
    }
  });

  await page.route('**/api/obs/restart', (route) =>
    route.fulfill({ json: { ok: true, message: 'OBS restarted' } }),
  );
}

test.describe('stream keys (Settings)', () => {
  test('shows stream keys card with platform selector and key inputs', async ({
    page,
  }) => {
    await mockSettings(page);
    await page.goto('/settings');

    const streamKeysCard = page.locator('text=Stream Keys').first();
    await expect(streamKeysCard).toBeVisible();

    await expect(page.getByLabel('Twitch stream key')).toBeVisible();
    await expect(page.locator('input[id="multistream-kick"]')).toBeVisible();
    await expect(page.locator('input[id="multistream-youtube"]')).toBeVisible();
  });

  test('shows primary platform with "Primary (Built-in)" label', async ({
    page,
  }) => {
    await mockSettings(page);
    await page.goto('/settings');

    await expect(page.getByText('Primary (Built-in)')).toBeVisible();
  });

  test('shows masked key status when keys are configured', async ({ page }) => {
    await mockSettings(page);
    await page.goto('/settings');

    await expect(
      page.getByText(/Currently set \(••••5678\)/),
    ).toBeVisible();
  });

  test('saves stream keys and automatically restarts OBS', async ({ page }) => {
    await mockSettings(page);
    await page.goto('/settings');

    // Accept the confirmation dialog that appears when saving multistream keys
    page.on('dialog', (dialog) => dialog.accept());

    const twitchKey = page.getByLabel('Twitch stream key');
    await twitchKey.fill('twitch_stream_key_123');

    const kickKey = page.locator('input[id="multistream-kick"]');
    await kickKey.fill('kick_stream_key_456');

    await page.getByRole('button', { name: 'Save all keys' }).click();

    await expect(
      page.getByText(/Stream keys saved — OBS restarted automatically/),
    ).toBeVisible();
  });
});
