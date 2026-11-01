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

test('local and account documents share one newest-first list with location icons', async ({ page }) => {
  const cloudOnly = { id: 'cloud-only', code: 'Cloud123', title: 'Cloud only', updated_at: Date.now() + 120000 };
  let shared;
  await page.route('**/api/me', route => route.fulfill({ json: { user: { id: 'owner', username: 'writer' } } }));
  await page.route('**/api/documents', async route => {
    if (route.request().method() === 'GET') {
      return route.fulfill({ json: { documents: [cloudOnly, ...(shared ? [shared] : [])] } });
    }
    shared = { id: 'shared-cloud', code: route.request().postDataJSON().code, title: 'Shared paper', updated_at: Date.now() + 60000 };
    return route.fulfill({ json: { document: { id: shared.id, code: shared.code, revision: 1 } } });
  });
  await page.goto('/');
  const projects = page.getByRole('list', { name: 'Projects' });
  await expect(projects).toContainText('Cloud only');
  await projects.getByRole('button').filter({ hasText: 'Untitled paper' }).click();
  await editorReady(page);
  await page.getByRole('textbox', { name: 'Document title' }).fill('Shared paper');
  await page.getByRole('button', { name: 'Save to account' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Saved to your account' })).toBeVisible();

  const documents = page.getByRole('navigation', { name: 'Documents' });
  await expect(documents.locator('.document-item')).toHaveCount(2);
  await expect(documents.getByRole('button').filter({ hasText: 'Shared paper' })).toHaveCount(1);
  await expect(documents.getByRole('img', { name: 'Available on this device and in your account' })).toHaveCount(1);
  await expect(documents.getByRole('img', { name: 'Available in your account' })).toHaveCount(1);
  await expect(page.getByRole('navigation', { name: 'Cloud documents' })).toHaveCount(0);

  await page.getByRole('button', { name: 'Your projects', exact: true }).click();
  await expect(projects.locator('.projects-open')).toHaveCount(2);
  await expect(projects.locator('.projects-open').filter({ hasText: 'Shared paper' })).toHaveCount(1);
  await expect(projects.getByRole('img', { name: 'Available on this device and in your account' })).toHaveCount(1);
  await expect(projects.getByRole('button').first()).toContainText('Cloud only');
  for (const width of [390, 320]) {
    await page.setViewportSize({ width, height: 844 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(width);
    const undersized = await page.locator('.projects-page button,.projects-page a,.projects-page input').evaluateAll(elements =>
      elements.filter(element => element.getClientRects().length).flatMap(element => {
        const box = element.getBoundingClientRect();
        return box.width < 43.9 || box.height < 43.9 ? [element.getAttribute('aria-label') || element.textContent] : [];
      }));
    expect(undersized).toEqual([]);
  }
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
    await expect.poll(() => page.evaluate(() => latex.read())).toBe('Imported from projects');
    if (width <= 1050) {
      await expect(page.getByRole('button', { name: 'Read', exact: true })).toHaveAttribute('aria-pressed', 'true');
      await expect(page.locator('.latex-editor')).toHaveCount(0);
    } else await expectSource(page, 'Imported from projects');
  });
}
