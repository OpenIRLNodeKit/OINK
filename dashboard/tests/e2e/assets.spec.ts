// SPDX-FileCopyrightText: 2026 OpenIRLNodeKit contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
import { test, expect, type Page } from '@playwright/test';

/**
 * Asset management smoke test. The AssetManager island is exercised against
 * stubbed /api/assets routes (same contract as log-server.js): GET lists,
 * POST stores (X-Filename header), DELETE removes by URL-encoded name.
 */
interface StubFile {
  name: string;
  size: number;
  mtime: number;
}

async function stubAssets(page: Page) {
  const files: StubFile[] = [];

  await page.route('**/api/assets**', async (route) => {
    const req = route.request();
    const pathname = new URL(req.url()).pathname;
    const method = req.method();

    if (method === 'GET' && pathname === '/api/assets') {
      return route.fulfill({ json: { ok: true, files } });
    }

    if (method === 'POST' && pathname === '/api/assets') {
      const name = req.headers()['x-filename'] ?? 'unknown.bin';
      const file: StubFile = { name, size: 4, mtime: Date.now() };
      files.push(file);
      return route.fulfill({
        json: { ok: true, message: `Uploaded ${name}`, file },
      });
    }

    if (method === 'DELETE' && pathname.startsWith('/api/assets/')) {
      const match = /^\/api\/assets\/([\s\S]+)$/.exec(pathname);
      if (!match) return route.fulfill({ json: { ok: false, error: 'bad name' } });
      const name = decodeURIComponent(match[1]);
      const idx = files.findIndex((f) => f.name === name);
      if (idx === -1) {
        return route.fulfill({ json: { ok: false, error: `Asset not found: ${name}` } });
      }
      files.splice(idx, 1);
      return route.fulfill({ json: { ok: true, message: `Deleted ${name}` } });
    }

    return route.continue();
  });
}

test.describe('assets', () => {
  test('uploads a file by drop-in input and deletes it', async ({ page }) => {
    await stubAssets(page);
    await page.goto('/assets');

    await expect(page.getByRole('heading', { name: 'Assets', exact: true })).toBeVisible();
    await expect(page.getByTestId('asset-dropzone')).toBeVisible();
    await expect(page.getByText(/No assets yet/)).toBeVisible();

    await page.getByTestId('asset-input').setInputFiles({
      name: 'bg.png',
      mimeType: 'image/png',
      buffer: Buffer.from('fake image bytes'),
    });

    await expect(page.getByText('Uploaded bg.png')).toBeVisible();
    const row = page.locator('li', { hasText: 'bg.png' });
    await expect(row).toBeVisible();
    await expect(page.getByText(/1 file on this server/)).toBeVisible();

    await page.getByRole('button', { name: 'Delete bg.png' }).click();
    await expect(page.getByText('Deleted bg.png')).toBeVisible();
    await expect(row).toHaveCount(0);
    await expect(page.getByText(/No assets yet/)).toBeVisible();
  });
});
