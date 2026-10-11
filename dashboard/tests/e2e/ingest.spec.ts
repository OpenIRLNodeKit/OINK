// SPDX-FileCopyrightText: 2026 OpenIRLNodeKit contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
import { expect, type Page, test } from '@playwright/test';

/**
 * Ingest page against mocked /api/* routes (see log-server.js for the real
 * contract): GET /api/ingest -> { ok, key, defaultPath }, POST
 * /api/obs/media-source -> { ok, message }. The stream key itself is managed on
 * the Settings page now (see settings-stream-key.spec.ts); the ingest page only
 * consumes it to build keyed URLs.
 */

const KEY = 'SecretKey_123456789012345';
const PATH = `live/${KEY}/irl_main`;

async function mockIngest(page: Page, overrides: { failGet?: boolean } = {}) {
  await page.route('**/api/auth/status', (route) =>
    route.fulfill({ json: { ok: false, enabled: false, user: null } }),
  );

  await page.route('**/api/ingest', async (route) => {
    if (route.request().method() === 'GET') {
      if (overrides.failGet) {
        await route.fulfill({
          status: 403,
          json: { ok: false, error: 'forbidden' },
        });
      } else {
        await route.fulfill({
          json: {
            ok: true,
            key: KEY,
            defaultPath: `${PATH}/stream`,
            createdAt: 1,
            updatedAt: 1,
          },
        });
      }
    } else {
      await route.fulfill({
        status: 404,
        json: { ok: false, error: 'not found' },
      });
    }
  });

  await page.route('**/api/obs/media-source', (route) =>
    route.fulfill({
      json: { ok: true, message: 'Provisioned in OBS (main scene)' },
    }),
  );

  let profiles: string[] = [];
  let main = 'irl';
  await page.route('**/api/ingest/profiles', async (route) => {
    if (route.request().method() === 'PUT') {
      const body = route.request().postDataJSON();
      profiles = (body.profiles as string[]) ?? [];
      main = typeof body.main === 'string' ? body.main : 'irl';
    }
    await route.fulfill({ json: { ok: true, profiles, main } });
  });
}

test.describe('Ingest', () => {
  test('renders keyed URLs after the stream name is saved', async ({
    page,
  }) => {
    await mockIngest(page);
    await page.goto('/ingest');

    await page.getByLabel('Stream Name', { exact: true }).fill('irl_main');
    await page.getByRole('button', { name: 'Save Current' }).click();

    const rtmp = page.getByLabel('RTMP URL');
    await expect(rtmp).toHaveValue(`rtmp://127.0.0.1:1935/${PATH}`);
    await expect(page.getByLabel('Stream key')).toHaveCount(0);

    await expect(page.getByLabel('Destination name')).toHaveValue('irl_main');
    await expect(page.getByLabel('Primary Ingress URL')).toHaveValue(
      'srt://127.0.0.1:8890',
    );
    await expect(page.getByLabel('Stream Name / Key')).toHaveValue(
      `publish:${PATH}`,
    );

    await expect(page.getByLabel('SRTLA server address')).toHaveValue(
      '127.0.0.1',
    );
    await expect(page.getByLabel('SRTLA port')).toHaveValue('5000');
    await expect(page.getByLabel('SRT streamid')).toHaveValue(
      `publish:${PATH}`,
    );

    await expect(page.getByText('IRLwhatever', { exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Show QR' })).toHaveCount(3);
    await page.getByRole('button', { name: 'Show QR' }).last().click();
    await expect(page.getByTestId('qr-modal-irlwhatever')).toBeVisible();
    await page.getByRole('button', { name: 'Close QR' }).click();
    await expect(page.getByTestId('qr-modal-irlwhatever')).toHaveCount(0);
  });

  test('locks URL cards until a profile is saved', async ({ page }) => {
    await mockIngest(page);
    await page.goto('/ingest');

    await page.getByLabel('Stream Name', { exact: true }).fill('irl_main');
    await expect(page.getByLabel('RTMP URL')).toHaveValue('');
    await expect(
      page.getByRole('button', { name: 'Copy' }).first(),
    ).toBeDisabled();
    await expect(page.getByText(/unlock these links/)).toBeVisible();
  });

  test('shows a key error state when the server forbids access', async ({
    page,
  }) => {
    await mockIngest(page, { failGet: true });
    await page.goto('/ingest');

    await expect(page.getByText('forbidden')).toBeVisible();
  });

  test('provisions OBS on Save Current', async ({ page }) => {
    let provisionBody: string | null = null;
    await mockIngest(page);
    await page.route('**/api/obs/media-source', async (route) => {
      provisionBody = JSON.stringify(route.request().postDataJSON());
      await route.fulfill({
        json: { ok: true, message: 'Provisioned in OBS (main scene)' },
      });
    });

    await page.goto('/ingest');
    await page.getByLabel('Stream Name', { exact: true }).fill('irl_main');
    await page.getByRole('button', { name: 'Save Current' }).click();

    await expect(page.getByText(/Provisioned in OBS/)).toBeVisible();
    expect(provisionBody).toContain(
      'streamid=read:live/SecretKey_123456789012345/irl_main',
    );
  });
});
