import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';

const sourceEditor = page => page.getByRole('textbox', { name: 'LaTeX source', exact: true });
const titleEditor = page => page.getByRole('textbox', { name: 'Document title', exact: true });
const localDocuments = page => page.getByRole('navigation', { name: 'Local documents' }).getByRole('button');
const saved = page => page.getByRole('status').filter({ hasText: 'Saved on this device' });

async function observeStorage(page) {
  await page.addInitScript(() => {
    window.draftWrites = 0;
    window.saveDelay = 0;
    const put = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put = function (...args) {
      window.draftWrites++;
      if (window.failDraftWrites) throw new DOMException('Storage is full', 'QuotaExceededError');
      return put.apply(this, args);
    };
    const complete = Object.getOwnPropertyDescriptor(IDBTransaction.prototype, 'oncomplete');
    Object.defineProperty(IDBTransaction.prototype, 'oncomplete', {
      ...complete,
      set(handler) {
        complete.set.call(this, event => {
          const delay = window.saveDelay;
          if (delay) setTimeout(() => handler.call(this, event), delay);
          else handler.call(this, event);
        });
      },
    });
  });
}

test('switching flushes keystrokes that arrive while a local save is completing', async ({ page }) => {
  await observeStorage(page);
  await page.goto('/');
  await expect(sourceEditor(page)).toBeEnabled();
  await sourceEditor(page).fill('first document');
  await titleEditor(page).fill('First');
  await expect(saved(page)).toBeVisible();
  await page.getByRole('button', { name: 'New document' }).click();
  await expect(localDocuments(page)).toHaveCount(2);
  await expect(saved(page)).toBeVisible();
  await page.evaluate(() => { window.saveDelay = 500; });
  await sourceEditor(page).fill('before the switch');
  const writes = await page.evaluate(() => window.draftWrites);
  await localDocuments(page).filter({ hasText: 'First' }).click();
  await expect.poll(() => page.evaluate(() => window.draftWrites)).toBeGreaterThan(writes);
  await sourceEditor(page).fill('last keystrokes during the save');
  await expect(sourceEditor(page)).toHaveValue('first document');
  await page.evaluate(() => { window.saveDelay = 0; });
  await localDocuments(page).filter({ hasText: 'Untitled paper' }).click();
  await expect(sourceEditor(page)).toHaveValue('last keystrokes during the save');
  await expect(saved(page)).toBeVisible();
  await page.reload();
  await expect(sourceEditor(page)).toHaveValue('last keystrokes during the save');
});

test('reopening a linked cloud draft replaces visible inputs and persists the fetched text', async ({ page }) => {
  let cloud = { id: 'cloud-document', title: 'Cloud title', source: 'original cloud text', revision: 1 };
  await page.route('**/api/me', route => route.fulfill({ json: { user: { id: 'owner', username: 'writer' } } }));
  await page.route('**/api/documents', route => route.fulfill({ json: { documents: [cloud] } }));
  await page.route('**/api/documents/cloud-document', route => route.fulfill({ json: { document: cloud } }));
  await page.goto('/');
  await expect(sourceEditor(page)).toBeEnabled();
  const openCloud = page.getByRole('navigation', { name: 'Cloud documents' }).getByRole('button');
  await openCloud.click();
  await expect(sourceEditor(page)).toHaveValue('original cloud text');
  await sourceEditor(page).fill('local edits not yet debounced');
  cloud = { ...cloud, title: 'Updated cloud title', source: 'new cloud text', revision: 2 };
  let prompted = false;
  page.once('dialog', async dialog => { prompted = true; await dialog.accept(); });
  await openCloud.click();
  await expect(sourceEditor(page)).toHaveValue('new cloud text');
  await expect(titleEditor(page)).toHaveValue('Updated cloud title');
  expect(prompted).toBe(true);
  await expect(page.getByRole('status').filter({ hasText: 'Saved to your account' })).toBeVisible();
  await page.reload();
  await expect(sourceEditor(page)).toHaveValue('new cloud text');
  await expect(titleEditor(page)).toHaveValue('Updated cloud title');
});

test('typing is debounced, keeps the editor node and does not send source to the API', async ({ page }) => {
  await observeStorage(page);
  const apiWrites = [];
  page.on('request', request => {
    if (request.url().includes('/api/') && request.method() !== 'GET') apiWrites.push(request.url());
  });
  await page.goto('/');
  await expect(sourceEditor(page)).toBeEnabled();
  const editor = await sourceEditor(page).elementHandle();
  const writes = await page.evaluate(() => window.draftWrites);
  await sourceEditor(page).fill('typing ');
  await sourceEditor(page).pressSequentially('a short burst');
  await expect(saved(page)).toBeVisible();
  expect(await page.evaluate(() => window.draftWrites)).toBe(writes + 1);
  expect(await editor.evaluate(node => node === document.querySelector('textarea'))).toBe(true);
  await sourceEditor(page).blur();
  expect(await page.evaluate(() => window.draftWrites)).toBe(writes + 1);
  expect(apiWrites).toEqual([]);
});

test('a failed local write keeps the current source exportable and retries the latest edits', async ({ page }) => {
  await observeStorage(page);
  await page.goto('/');
  await expect(sourceEditor(page)).toBeEnabled();
  await page.evaluate(() => { window.failDraftWrites = true; });
  await sourceEditor(page).fill('source to recover');
  await expect(page.getByRole('alert')).toContainText('Storage is full');
  await expect(page.getByRole('status').filter({ hasText: 'Local save failed' })).toBeVisible();
  await page.getByRole('button', { name: 'New document' }).click();
  await expect(sourceEditor(page)).toHaveValue('source to recover');
  await expect(localDocuments(page)).toHaveCount(1);
  const exported = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export .tex' }).click();
  expect(await readFile(await (await exported).path(), 'utf8')).toBe('source to recover');
  await page.evaluate(() => { window.failDraftWrites = false; });
  await sourceEditor(page).fill('latest recovered source');
  await expect(saved(page)).toBeVisible();
  await page.reload();
  await expect(sourceEditor(page)).toHaveValue('latest recovered source');
});

test('Tab respects the source limit, Shift+Tab leaves the editor, and mobile export stays accessible', async ({ page }) => {
  await page.goto('/');
  await expect(sourceEditor(page)).toBeEnabled();
  const text = 'x'.repeat(99999);
  await sourceEditor(page).fill(text);
  await sourceEditor(page).press('Control+End');
  await sourceEditor(page).press('Tab');
  await expect(sourceEditor(page)).toHaveValue(text);
  await sourceEditor(page).press('Shift+Tab');
  await expect(sourceEditor(page)).not.toBeFocused();
  await sourceEditor(page).fill('abcd');
  await sourceEditor(page).evaluate(input => { input.focus(); input.setSelectionRange(1, 3); });
  await sourceEditor(page).press('Tab');
  await expect(sourceEditor(page)).toHaveValue('a  d');
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(sourceEditor(page)).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(390);
  const exported = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export .tex' }).click();
  expect(await readFile(await (await exported).path(), 'utf8')).toBe('a  d');
  await page.getByRole('button', { name: 'Toggle documents' }).click();
  await expect(page.getByRole('button', { name: 'Import .tex file' })).toBeVisible();
  await page.locator('input[type=file]').setInputFiles({ name: 'mobile.tex', mimeType: 'text/plain', buffer: Buffer.from('imported mobile source') });
  await expect(sourceEditor(page)).toHaveValue('imported mobile source');
  await expect(saved(page)).toBeVisible();
});
