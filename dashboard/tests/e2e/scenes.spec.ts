// SPDX-FileCopyrightText: 2026 OpenIRLNodeKit contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
import { test, expect, type Page } from '@playwright/test';

/**
 * OBS scene switching on /dashboard against mocked /api/obs/* routes (see
 * log-server.js for the real contract: scenes -> { ok, currentProgramScene, scenes[] },
 * switch -> { ok, message, sceneName }).
 */

async function mockObsScenes(
  page: Page,
  scenes: string[],
  initial: string,
) {
  let current = initial;

  await page.route('**/api/obs/scenes', (route) => {
    if (route.request().method() === 'GET') {
      route.fulfill({
        json: { ok: true, currentProgramScene: current, scenes },
      });
    } else {
      route.fulfill({ json: { ok: true, message: 'switched' } });
    }
  });

  await page.route('**/api/obs/scenes/switch', (route) => {
    const body = route.request().postDataJSON() as { sceneName: string };
    current = body.sceneName;
    route.fulfill({ json: { ok: true, message: `Switched to ${body.sceneName}`, sceneName: body.sceneName } });
  });
}

test.describe('OBS scene switching', () => {
  test('renders scene buttons and flips the active scene on click', async ({ page }) => {
    await mockObsScenes(page, ['main', 'brb', 'offline'], 'main');

    await page.goto('/dashboard');

    const sceneGroup = page.getByRole('group', { name: 'OBS scenes' });
    await expect(sceneGroup.getByRole('button', { name: 'main' })).toHaveAttribute('aria-pressed', 'true');

    await sceneGroup.getByRole('button', { name: 'brb' }).click();

    await expect(sceneGroup.getByRole('button', { name: 'brb' })).toHaveAttribute('aria-pressed', 'true');
    await expect(sceneGroup.getByRole('button', { name: 'main' })).toHaveAttribute('aria-pressed', 'false');
  });

  test('shows an empty state when OBS has no scenes', async ({ page }) => {
    await page.route('**/api/obs/scenes', (route) =>
      route.fulfill({ json: { ok: true, currentProgramScene: '', scenes: [] } }),
    );

    await page.goto('/dashboard');

    await expect(page.getByText(/No scenes available/)).toBeVisible();
  });
});
