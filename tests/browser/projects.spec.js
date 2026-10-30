import { test, expect } from '@playwright/test';
import { editorReady, fillSource, expectSource } from './source-editor.js';

test('Projects dashboard searches, sorts, switches views and opens a persistent source workspace', async ({ page }) => {
  const resources = [];
  page.on('request', request => resources.push(request.url()));
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Your projects' })).toBeVisible();
  await expect(page.getByRole('list', { name: 'Projects' }).getByRole('button')).toHaveCount(1);
  expect(resources.some(url => /\/assets\/monaco-|\/compiler\//.test(url))).toBe(false);
  await page.getByRole('searchbox', { name: 'Search projects' }).fill('does not exist');
  await expect(page.getByRole('heading', { name: 'No matching documents' })).toBeVisible();
  await page.getByRole('searchbox', { name: 'Search projects' }).clear();
  await page.getByRole('button', { name: 'Grid view', exact: true }).click();
  await expect(page.locator('.projects-list')).toHaveClass(/projects-grid/);
  await page.getByRole('button', { name: 'List view', exact: true }).click();
  await expect(page.locator('.projects-list')).not.toHaveClass(/projects-grid/);
  await page.getByRole('list', { name: 'Projects' }).getByRole('button').first().click();
  await editorReady(page);
  await fillSource(page, 'Dashboard round trip');
  await page.getByRole('textbox', { name: 'Document title' }).fill('Alpha paper');
  await expect(page.getByRole('status').filter({ hasText: 'Saved on this device' })).toBeVisible();
  await page.getByRole('button', { name: 'Your projects', exact: true }).click();
  await expect(page).not.toHaveURL(/#workspace/);
  await expect(page.getByRole('list', { name: 'Projects' })).toContainText('Alpha paper');
  await page.getByRole('button', { name: 'New document', exact: true }).click();
  await editorReady(page);
  await page.getByRole('textbox', { name: 'Document title' }).fill('Beta paper');
  await expect(page.getByRole('status').filter({ hasText: 'Saved on this device' })).toBeVisible();
  await page.getByRole('button', { name: 'Your projects', exact: true }).click();
  await page.getByRole('button', { name: /^Sort by name/ }).click();
  await expect(page.getByRole('list', { name: 'Projects' }).getByRole('button').first()).toContainText('Alpha paper');
  await page.getByRole('list', { name: 'Projects' }).getByRole('button').first().click();
  await expectSource(page, 'Dashboard round trip');
});

for (const width of [1920, 390, 320]) {
  test(`Projects dashboard has dark surfaces, accessible controls and no overflow at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.goto('/');
    await expect(page.getByRole('heading', { name: 'Your projects' })).toBeVisible();
    expect(await page.locator('.projects-main').evaluate(element => getComputedStyle(element).backgroundColor)).toBe('rgb(32, 32, 32)');
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(width);
    const undersized = await page.locator('.projects-page button,.projects-page a,.projects-page input').evaluateAll(elements =>
      elements.filter(element => element.getClientRects().length).flatMap(element => {
        const box = element.getBoundingClientRect();
        return box.width < 43.9 || box.height < 43.9 ? [element.getAttribute('aria-label') || element.textContent] : [];
      }));
    expect(undersized).toEqual([]);
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();
    await expect(page.getByRole('dialog')).toBeVisible();
    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: 'Import .tex', exact: false }).click();
    await page.locator('input[type=file]').setInputFiles({ name: 'dashboard.tex', mimeType: 'text/plain', buffer: Buffer.from('Imported from projects') });
    await expectSource(page, 'Imported from projects');
  });
}
