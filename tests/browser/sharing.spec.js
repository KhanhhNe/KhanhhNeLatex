import { test, expect, devices } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

const source = String.raw`\documentclass{article}\begin{document}Read-only shared paper.\end{document}`;
async function ownerClient(playwright, baseURL) {
  const client = await playwright.request.newContext({ baseURL, extraHTTPHeaders: { Origin: baseURL } });
  const response = await client.post('/api/register', { data: { username: `share_${crypto.randomUUID().slice(0, 12)}`, password: 'test-sharing-password' } });
  expect(response.status(), await response.text()).toBe(201);
  return client;
}

test('share API authenticates owners, reuses IDs, rejects writes and revokes anonymous access', async ({ playwright, request, baseURL }) => {
  const owner = await ownerClient(playwright, baseURL);
  const other = await ownerClient(playwright, baseURL);
  let id;
  try {
    const created = await owner.post('/api/documents', { data: { title: 'Shared paper', source } });
    id = (await created.json()).document.id;
    expect((await request.post(`/api/documents/${id}/share`, { headers: { Origin: baseURL }, data: {} })).status()).toBe(401);
    expect((await other.post(`/api/documents/${id}/share`, { data: {} })).status()).toBe(404);
    expect((await owner.post(`/api/documents/${id}/share`, { headers: { Origin: 'https://evil.invalid' }, data: {} })).status()).toBe(403);
    const shares = await Promise.all([0, 1, 2].map(() => owner.post(`/api/documents/${id}/share`, { data: {} }).then(response => response.json())));
    const shareId = shares[0].share.id;
    expect(shareId).toMatch(/^[a-f0-9]{64}$/);
    expect(new Set(shares.map(result => result.share.id)).size).toBe(1);
    const read = await request.get(`/api/shares/${shareId}`);
    expect(read.status()).toBe(200);
    expect(read.headers()['cache-control']).toBe('no-store');
    expect((await read.json()).document).toEqual({ title: 'Shared paper', source, updated_at: expect.any(Number) });
    for (const method of ['post', 'put', 'patch', 'delete']) {
      expect((await request[method](`/api/shares/${shareId}`, { headers: { Origin: baseURL }, data: { title: 'Hacked', source: 'changed' } })).status()).toBe(404);
    }
    for (const path of [`/api/documents/${id}`, `/api/documents/${shareId}`, '/api/documents/sync', `/api/documents/${id}/share`]) {
      for (const method of ['post', 'put', 'patch', 'delete']) {
        expect((await request[method](path, { headers: { Origin: baseURL, Authorization: `Bearer ${shareId}` }, data: { title: 'Hacked', source: 'changed', shareId, revision: 1 } })).status()).toBe(401);
      }
    }
    expect((await other.put(`/api/documents/${shareId}`, { data: { title: 'Hacked', source, revision: 1 } })).status()).toBe(404);
    expect((await other.delete(`/api/documents/${id}/share`)).status()).toBe(404);
    expect((await owner.get(`/api/documents/${id}`).then(response => response.json())).document.source).toBe(source);
    expect((await owner.put(`/api/documents/${id}`, { data: { title: 'Updated paper', source: source + '\n', revision: 1 } })).status()).toBe(200);
    expect((await request.get(`/api/shares/${shareId}`).then(response => response.json())).document.source).toBe(source + '\n');
    await owner.delete(`/api/documents/${id}/share`);
    expect((await request.get(`/api/shares/${shareId}`)).status()).toBe(404);
    const next = (await owner.post(`/api/documents/${id}/share`, { data: {} }).then(response => response.json())).share.id;
    expect(next).not.toBe(shareId);
    await owner.delete(`/api/documents/${id}`);
    id = null;
    expect((await request.get(`/api/shares/${next}`)).status()).toBe(404);
  } finally {
    if (id) await owner.delete(`/api/documents/${id}`);
    await owner.dispose();
    await other.dispose();
  }
});

for (const { mobile, browserName } of [{ mobile: false, browserName: 'chromium' }, { mobile: true, browserName: 'chromium' }, { mobile: true, browserName: 'webkit' }]) {
  test(`${browserName} share dialog and anonymous read-only compilation on ${mobile ? 'mobile' : 'desktop'}`, async ({ playwright, baseURL }) => {
    const browser = await playwright[browserName].launch();
    const options = mobile ? { ...devices[browserName === 'webkit' ? 'iPhone 13 Pro' : 'Pixel 7'], viewport: { width: 390, height: 844 } }
      : { viewport: { width: 1440, height: 1000 } };
    const context = await browser.newContext({ baseURL, ...options });
    const page = await context.newPage();
    const owner = await ownerClient(playwright, baseURL);
    let id, anonymous;
    try {
      const created = await owner.post('/api/documents', { data: { title: 'Shared paper', source } });
      const document = (await created.json()).document;
      id = document.id;
      await page.context().addCookies((await owner.storageState()).cookies);
      if (!mobile) await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
      else await page.addInitScript(() => {
        Object.defineProperty(navigator.clipboard, 'writeText', { value: async () => { throw new DOMException('Denied', 'NotAllowedError'); } });
      });
      if (mobile) await page.setViewportSize({ width: 390, height: 844 });
      await page.goto(`/documents/shared-paper/${document.code}`);
      if (mobile) await page.getByRole('button', { name: 'More actions', exact: true }).click();
      await page.getByRole('button', { name: mobile ? 'Share read-only link' : 'Share', exact: true }).click();
      const dialog = page.getByRole('dialog', { name: 'Share read-only link' });
      await expect(dialog).toBeVisible();
      const link = dialog.getByRole('textbox', { name: 'Share link' });
      await expect(link).toHaveValue(/\/share\/[a-f0-9]{64}$/);
      const url = await link.inputValue();
      await expect(dialog.getByRole('button', { name: 'Copy link' })).toBeEnabled();
      if (!mobile) {
        await expect(dialog.getByRole('status')).toContainText('Link copied');
        expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(url);
        await dialog.getByRole('button', { name: 'Copy link' }).click();
        await page.keyboard.press('Tab');
        expect(await dialog.evaluate(element => element.contains(window.document.activeElement))).toBe(true);
      } else await expect(dialog.getByRole('status')).toContainText('Clipboard access is unavailable');
      if (process.env.SHARE_ARTIFACTS) await page.screenshot({ path: join(process.env.SHARE_ARTIFACTS, `share-dialog-${mobile ? 'mobile' : 'desktop'}.png`) });
      await page.keyboard.press('Escape');
      await expect(dialog).not.toBeVisible();
      if (mobile) await page.getByRole('button', { name: 'More actions', exact: true }).click();
      await page.getByRole('button', { name: mobile ? 'Share read-only link' : 'Share', exact: true }).click();
      await expect(dialog.getByRole('textbox', { name: 'Share link' })).toHaveValue(url);
      await page.keyboard.press('Escape');
      anonymous = await browser.newContext(options);
      const viewer = await anonymous.newPage();
      const writes = [], errors = [];
      viewer.on('request', request => { if (request.url().includes('/api/') && request.method() !== 'GET') writes.push(request.url()); });
      viewer.on('pageerror', error => errors.push(error.stack || error.message));
      await viewer.goto(url);
      await expect(viewer.getByRole('heading', { name: 'Shared paper' })).toBeVisible();
      await expect(viewer.locator('.shared-footer [role=status]')).toContainText('Compiled in your browser', { timeout: 60000 });
      await expect(viewer.locator('.pdf-viewer[title="Compiled PDF"]')).toBeVisible();
      await expect(viewer.getByRole('img', { name: 'PDF page 1. Open PDF for selectable text.' })).toBeVisible();
      const exporting = viewer.waitForEvent('download');
      await viewer.getByRole('button', { name: 'Export PDF', exact: true }).click();
      expect((await readFile(await (await exporting).path())).subarray(0, 5).toString()).toBe('%PDF-');
      if (process.env.SHARE_ARTIFACTS) await viewer.screenshot({ path: join(process.env.SHARE_ARTIFACTS, `share-viewer-${mobile ? 'mobile' : 'desktop'}.png`) });
      await viewer.getByRole('button', { name: 'View source' }).click();
      await expect(viewer.locator('.latex-editor-host')).toBeVisible();
      const editor = viewer.getByRole('textbox', { name: 'LaTeX source', exact: true });
      await expect(editor).toHaveJSProperty('readOnly', true);
      await editor.press('Control+End');
      await viewer.keyboard.insertText('MUST NOT BE SAVED');
      await expect(viewer.locator('.view-lines')).not.toContainText('MUST NOT BE SAVED');
      if (process.env.SHARE_ARTIFACTS) await viewer.screenshot({ path: join(process.env.SHARE_ARTIFACTS, `share-source-${mobile ? 'mobile' : 'desktop'}.png`) });
      const texExporting = viewer.waitForEvent('download');
      await viewer.getByRole('button', { name: 'Export .tex', exact: true }).click();
      expect(await readFile(await (await texExporting).path(), 'utf8')).toBe(source);
      expect(await viewer.evaluate(() => document.documentElement.scrollWidth)).toBe(mobile ? 390 : 1440);
      await expect(viewer.getByRole('button', { name: 'Save to account' })).toHaveCount(0);
      await expect(viewer.getByRole('textbox', { name: 'Document title' })).toHaveCount(0);
      expect(writes).toEqual([]);
      expect(errors).toEqual([]);
      expect(await viewer.evaluate(async () => (await indexedDB.databases()).filter(database => database.name === 'folio-drafts').length)).toBe(0);
      await owner.delete(`/api/documents/${id}/share`);
      await viewer.reload();
      await expect(viewer.getByRole('alert')).toContainText('not found or link revoked');
    } finally {
      if (id) await owner.delete(`/api/documents/${id}`);
      await anonymous?.close();
      await owner.dispose();
      await browser.close();
    }
  });
}

test('device-only share explains sign-in and invalid links do not open editable workspace', async ({ page }) => {
  await page.goto('/#workspace');
  await page.getByRole('button', { name: 'Share', exact: true }).click();
  await expect(page.getByRole('dialog')).toContainText('Device-only drafts cannot be shared');
  await page.keyboard.press('Escape');
  await page.goto('/share/not-a-valid-share');
  await expect(page.getByRole('alert')).toContainText('not found or link revoked');
  await expect(page.getByRole('button', { name: 'Save to account' })).toHaveCount(0);
});
