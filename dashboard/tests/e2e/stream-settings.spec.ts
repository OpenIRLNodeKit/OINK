// SPDX-FileCopyrightText: 2026 OpenIRLNodeKit contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
import { test, expect, type Page } from '@playwright/test';

/**
 * Stream settings on /settings against mocked /api/obs/stream-settings (see
 * log-server.js for the real contract: GET -> { ok, encoder, outputWidth, ... },
 * PUT -> applies and returns the updated settings).
 */

async function mockStreamSettings(page: Page) {
  let current: Record<string, unknown> = {
    encoder: 'x264',
    outputWidth: 1920,
    outputHeight: 1080,
    fpsNumerator: 60,
    fpsDenominator: 1,
    bitrate: 6000,
    hasNvenc: false,
    streamActive: false,
  };

  await page.route('**/api/obs/stream-settings', (route) => {
    if (route.request().method() === 'PUT') {
      current = { ...current, ...route.request().postDataJSON() };
      route.fulfill({ json: { ok: true, message: 'Stream settings updated', ...current } });
    } else {
      route.fulfill({ json: { ok: true, ...current } });
    }
  });
}

test.describe('stream settings', () => {
  test('renders encoder + selects and applies resolution, framerate, and bitrate', async ({ page }) => {
    await mockStreamSettings(page);

    await page.goto('/settings');

    await expect(page.getByLabel('Resolution')).toHaveValue('1920x1080');
    await expect(page.getByLabel('Framerate')).toHaveValue('60');
    await expect(page.getByLabel('Bitrate')).toHaveValue('6000');
    await expect(page.getByLabel('Encoder')).toHaveValue('x264');

    await page.getByLabel('Resolution').selectOption('2560x1440');
    await expect(page.getByLabel('Bitrate')).toHaveValue('9000');
    await page.getByLabel('Framerate').selectOption('30');

    await page.getByRole('button', { name: 'Apply' }).click();

    const put = await page.waitForRequest(
      (r) =>
        r.url().includes('/api/obs/stream-settings') && r.method() === 'PUT',
    );
    expect(put.postDataJSON()).toEqual({
      encoder: 'x264',
      outputWidth: 2560,
      outputHeight: 1440,
      fpsNumerator: 30,
      fpsDenominator: 1,
      bitrate: 9000,
    });
    await expect(page.getByLabel('Resolution')).toHaveValue('2560x1440');
  });

  test('hides NVENC when the box has no NVIDIA GPU', async ({ page }) => {
    await mockStreamSettings(page);

    await page.goto('/settings');

    await expect(page.getByRole('option', { name: 'NVENC (NVIDIA)' })).toHaveCount(0);
  });
});
