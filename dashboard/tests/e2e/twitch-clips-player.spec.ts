// SPDX-FileCopyrightText: 2026 OpenIRLNodeKit contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
import { expect, test, type Page } from '@playwright/test';

/**
 * Twitch Clips Player overlay config on /overlays against mocked
 * /api/obs/browser-source (see log-server.js for the real contract:
 * POST { name, url, scenes, reroute_audio } -> { ok, source, scenes },
 * DELETE ?name= -> ok). The shared channel is set in Settings -> Stream Settings.
 */

async function setChannel(page: Page, channel: string) {
  let stored = '';
  await page.route('**/api/settings', async (route) => {
    if (route.request().method() === 'PUT') {
      const body = route.request().postDataJSON() as { twitchChannel?: string };
      if (typeof body.twitchChannel === 'string') stored = body.twitchChannel;
    }
    await route.fulfill({
      json: { ok: true, welcomeComplete: true, twitchChannel: stored, presetProvided: false },
    });
  });
  await page.goto('/settings');
  await page.getByLabel('Channel name').fill(channel);
  // useChannel debounces the save; wait for the PUT before navigating away.
  await page.waitForTimeout(500);
}

async function addMocks(page: Page) {
  await page.route('**/api/obs/browser-source', async (route) => {
    const req = route.request();
    if (req.method() === 'POST') {
      await route.fulfill({
        json: {
          ok: true,
          message: 'Browser source provisioned',
          source: 'twitch_clips',
          scenes: [{ scene: 'brb', sceneItemId: 1 }],
        },
      });
    } else {
      await route.fulfill({
        json: { ok: true, message: 'Browser source removed' },
      });
    }
  });
}

test.describe('twitch clips player', () => {
  test('renders the form and builds the URL from the shared channel', async ({
    page,
  }) => {
    await addMocks(page);
    await setChannel(page, 'my_stream');
    await page.goto('/overlays');

    await expect(page.getByRole('tab', { name: 'Twitch Clips' })).toBeVisible();
    await expect(
      page.getByRole('button', { name: /Apply to OBS/ }),
    ).toBeVisible();

    await expect(page.getByLabel('Generated URL')).toHaveValue(
      /channel=my_stream/,
    );
  });

  test('applies the widget to selected scenes', async ({ page }) => {
    let posted: unknown = null;
    await page.route('**/api/obs/browser-source', async (route) => {
      if (route.request().method() === 'POST') {
        posted = route.request().postDataJSON();
        await route.fulfill({ json: { ok: true, message: 'ok' } });
      } else {
        await route.fulfill({ json: { ok: true, message: 'ok' } });
      }
    });

    await setChannel(page, 'my_stream');
    await page.goto('/overlays');
    await page.locator('label:has(input[name="scene-brb"])').click();
    await page.locator('label:has(input[name="scene-offline"])').click();
    await page.getByRole('button', { name: /Apply to OBS/ }).click();

    await expect(page.getByText(/Added "twitch_clips"/)).toBeVisible();
    const body = posted as { name: string; url: string; scenes: string[] };
    expect(body.name).toBe('twitch_clips');
    expect(body.url).toContain('channel=my_stream');
    expect(body.scenes).toEqual(['low-br', 'offline']);
  });

  test('IRLServer Player provider builds a clips.irl.ac URL and applies it', async ({
    page,
  }) => {
    let posted: unknown = null;
    await page.route('**/api/obs/browser-source', async (route) => {
      if (route.request().method() === 'POST') {
        posted = route.request().postDataJSON();
        await route.fulfill({ json: { ok: true, message: 'ok' } });
      } else {
        await route.fulfill({ json: { ok: true, message: 'ok' } });
      }
    });

    await setChannel(page, 'my_stream');
    await page.goto('/overlays');

    await page.getByRole('button', { name: 'IRLServer Player' }).click();
    await expect(page.getByRole('heading', { name: 'Clip Filters' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Playback' })).toBeVisible();
    await expect(page.getByText('Clip Selection')).toHaveCount(0);

    await page.getByLabel('Days').fill('7');
    await page.getByLabel('Min views').fill('500');
    await page.getByRole('button', { name: /Apply to OBS/ }).click();

    await expect(page.getByText(/Added "twitch_clips"/)).toBeVisible();
    const body = posted as { name: string; url: string };
    expect(body.name).toBe('twitch_clips');
    expect(body.url).toContain('https://clips.irl.ac/');
    expect(body.url).toContain('channelName=my_stream');
    expect(body.url).toContain('days=7');
    expect(body.url).toContain('views=500');
  });
});
