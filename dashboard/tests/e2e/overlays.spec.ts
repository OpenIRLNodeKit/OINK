// SPDX-FileCopyrightText: 2026 OpenIRLNodeKit contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
import { expect, test, type Page } from '@playwright/test';

/**
 * Overlays page: horizontal tab bar with Twitch Clips and Chat
 * overlays, sharing a channel set in Settings -> Stream Settings, against a
 * mocked /api/obs/browser-source backend (matching log-server.js).
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

test.describe('overlays page', () => {
  test('shows horizontal tabs for Twitch Clips, Chat, and Custom URL', async ({
    page,
  }) => {
    await page.goto('/overlays');
    await expect(page.getByRole('tab', { name: 'Twitch Clips' })).toBeVisible();
    await expect(page.getByRole('tab', { name: 'Chat' })).toBeVisible();
    await expect(page.getByRole('tab', { name: 'Custom URL' })).toBeVisible();
  });

  test('provides links to the overlay websites', async ({
    page,
  }) => {
    await page.goto('/overlays');

    // Twitch Clips tab -> twitchclipsplayer.com
    await expect(
      page.getByRole('link', { name: /Twitch Clips Player/ }),
    ).toHaveAttribute('href', 'https://twitchclipsplayer.com/');

    // JstChat tab -> JstChat2 site
    await page.getByRole('tab', { name: 'Chat' }).click();
    await expect(
      page.getByRole('link', { name: /JstChat2/ }),
    ).toHaveAttribute('href', 'https://itsalviiin.github.io/JstChat2/#/');
  });

  test('Custom URL tab lets you paste any browser-source URL', async ({
    page,
  }) => {
    const posted: {
      body: {
        name: string;
        url: string;
        scenes: string[];
        reroute_audio?: boolean;
      } | null;
    } = { body: null };
    await page.route('**/api/obs/browser-source', async (route) => {
      if (route.request().method() === 'POST') {
        posted.body = route.request().postDataJSON() as typeof posted.body;
        await route.fulfill({ json: { ok: true, message: 'ok' } });
      } else {
        await route.fulfill({ json: { ok: true, message: 'ok' } });
      }
    });

    await page.goto('/overlays');
    await page.getByRole('tab', { name: 'Custom URL' }).click();

    await expect(
      page.getByRole('heading', { name: 'Source', exact: true }),
    ).toBeVisible();
    await expect(page.getByLabel('OBS source name')).toHaveValue('custom_overlay');
    await expect(page.getByLabel('OBS Source URL')).toHaveValue('');

    await page.getByLabel('OBS Source URL').fill('https://example.com/my-overlay');
    await expect(
      page.locator('input[name="rerouteAudio"]'),
    ).toBeChecked();
    await page.locator('label:has(input[name="rerouteAudio"])').click();
    await expect(
      page.locator('input[name="rerouteAudio"]'),
    ).not.toBeChecked();
    await page.getByRole('button', { name: /Apply to OBS/ }).click();

    const body = posted.body;
    expect(body?.name).toBe('custom_overlay');
    expect(body?.url).toBe('https://example.com/my-overlay');
    expect(body?.reroute_audio).toBe(false);
  });

  test('lists Overlays above Settings in the sidebar', async ({ page }) => {
    await page.goto('/dashboard');
    const overlaysLink = page.locator('aside a[href="/overlays"]');
    const settingsLink = page.locator('aside a[href="/settings"]');
    await expect(overlaysLink).toBeVisible();
    await expect(settingsLink).toBeVisible();
    const overlaysBox = await overlaysLink.boundingBox();
    const settingsBox = await settingsLink.boundingBox();
    expect(overlaysBox).not.toBeNull();
    expect(settingsBox).not.toBeNull();
    expect(overlaysBox!.y).toBeLessThan(settingsBox!.y);
  });

  test('switches to the JstChat tab and applies the chat source', async ({
    page,
  }) => {
    const posted: {
      body: {
        name: string;
        url: string;
        scenes: string[];
        reroute_audio?: boolean;
      } | null;
    } = { body: null };
    await page.route('**/api/obs/browser-source', async (route) => {
      if (route.request().method() === 'POST') {
        posted.body = route.request().postDataJSON() as typeof posted.body;
        await route.fulfill({ json: { ok: true, message: 'ok' } });
      } else {
        await route.fulfill({ json: { ok: true, message: 'ok' } });
      }
    });

    await setChannel(page, 'castle_');
    await page.goto('/overlays');
    await page.getByRole('tab', { name: 'Chat' }).click();

    await expect(page.getByLabel('Generated URL')).toHaveValue(
      /channel=castle_/,
    );
    await page.getByRole('button', { name: /Apply to OBS/ }).click();

    await expect(page.getByText(/Added "twitch_chat"/)).toBeVisible();
    expect(posted.body?.name).toBe('twitch_chat');
    expect(posted.body?.url).toContain('channel=castle_');
    // Chat overlays are silent: no audio rerouting.
    expect(posted.body?.reroute_audio).toBe(false);
  });

  test('toggles chat options and applies them to the source URL', async ({
    page,
  }) => {
    const posted: {
      body: {
        name: string;
        url: string;
      } | null;
    } = { body: null };
    await page.route('**/api/obs/browser-source', async (route) => {
      if (route.request().method() === 'POST') {
        posted.body = route.request().postDataJSON() as typeof posted.body;
      }
      await route.fulfill({ json: { ok: true, message: 'ok' } });
    });

    await setChannel(page, 'castle_');
    await page.goto('/overlays');
    await page.getByRole('tab', { name: 'Chat' }).click();

    await expect(page.getByText('Chat options')).toBeVisible();
    await page
      .locator('label:has(input[name="chat-hide-commands"])')
      .click();
    await expect(
      page.locator('input[name="chat-hide-commands"]'),
    ).toBeChecked();
    await page.getByLabel('Fade messages').fill('30');
    await page.getByRole('button', { name: /Apply to OBS/ }).click();

    const url = posted.body?.url ?? '';
    expect(url).toContain('channel=castle_');
    expect(url).toContain('hide_commands=true');
    expect(url).toContain('fade_after=30');
  });
});
