import { test, expect } from '@playwright/test';
import { editorReady, fillSource, expectSource } from './source-editor.js';

test('selection, rename, refresh and browser history preserve document identities and source', async ({ page }) => {
  const lookups = [];
  page.on('request', request => {
    if (/\/api\/documents/.test(request.url())) lookups.push(request.url());
  });
  await page.goto('/');
  await page.getByRole('list', { name: 'Projects' }).getByRole('button').first().click();
  await editorReady(page);
  await fillSource(page, 'First device draft');
  await expectSource(page, 'First device draft');
  await page.getByRole('textbox', { name: 'Document title' }).fill('Résumé / First paper');
  await expect(page).toHaveURL(/\/documents\/resume-first-paper\/[A-Za-z0-9_-]{8}$/);
  const first = new URL(page.url()).pathname;
  await page.getByRole('button', { name: 'New document', exact: true }).click();
  await editorReady(page);
  await fillSource(page, 'Second device draft');
  await expectSource(page, 'Second device draft');
  await page.getByRole('textbox', { name: 'Document title' }).fill('Second paper');
  await expect(page).toHaveURL(/\/documents\/second-paper\/[A-Za-z0-9_-]{8}$/);
  const second = new URL(page.url()).pathname;
  expect(second).not.toBe(first);
  await expect(page.getByRole('status').filter({ hasText: 'Saved on this device' })).toBeVisible();
  await page.goBack();
  await expectSource(page, 'First device draft');
  await expect(page).toHaveURL(new RegExp(first + '$'));
  await page.goForward();
  await expectSource(page, 'Second device draft');
  await expect(page).toHaveURL(new RegExp(second + '$'));
  await page.reload();
  await expectSource(page, 'Second device draft');
  await page.goto(second.replace('second-paper', 'wrong-slug'));
  await expectSource(page, 'Second device draft');
  await expect(page).toHaveURL(new RegExp(second + '$'));
  await page.getByRole('button', { name: 'Your projects', exact: true }).click();
  await expect(page).toHaveURL(/\/$/);
  await page.goBack();
  await expectSource(page, 'Second device draft');
  expect(lookups).toEqual([]);
});

test('unknown and malformed links do not open an unrelated device draft', async ({ page }) => {
  await page.goto('/documents/missing/abcdefgh');
  await expect(page.getByRole('heading', { name: 'Document unavailable' })).toBeVisible();
  await expect(page.getByRole('status')).toContainText('Sign in');
  await expect(page.getByRole('textbox', { name: 'Document title' })).toHaveCount(0);
  await page.goto('/documents/missing/not-eight-characters');
  await expect(page.getByRole('status')).toContainText('Document not found');
});

test('legacy device drafts receive persistent codes without changing their source', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('list', { name: 'Projects' })).toBeVisible();
  await page.evaluate(async () => {
    const db = await new Promise((resolve, reject) => {
      const request = indexedDB.open('folio-drafts', 1);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    await new Promise((resolve, reject) => {
      const tx = db.transaction('documents', 'readwrite');
      tx.objectStore('documents').put({
        id: 'legacy', title: 'Legacy draft', source: 'Keep this exact source',
        updated_at: Date.now(), cloudId: null, owner: null, dirty: true,
      });
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
    });
    db.close();
  });
  await page.reload();
  await page.getByRole('list', { name: 'Projects' }).getByRole('button').filter({ hasText: 'Legacy draft' }).click();
  await expectSource(page, 'Keep this exact source');
  await expect(page).toHaveURL(/\/documents\/legacy-draft\/[A-Za-z0-9_-]{8}$/);
  const path = new URL(page.url()).pathname;
  await page.reload();
  await expectSource(page, 'Keep this exact source');
  expect(new URL(page.url()).pathname).toBe(path);
});

test('a delayed account save does not navigate away from projects', async ({ page }) => {
  let finishSave;
  let refreshed = false;
  await page.route('**/api/me', route => route.fulfill({ json: { user: { id: 'owner', username: 'writer' } } }));
  await page.route('**/api/documents', async route => {
    if (route.request().method() === 'GET') {
      if (finishSave) refreshed = true;
      return route.fulfill({ json: { documents: [] } });
    }
    await new Promise(resolve => { finishSave = resolve; });
    await route.fulfill({ json: { document: { id: 'cloud', code: route.request().postDataJSON().code, revision: 1 } } });
  });
  await page.goto('/#workspace');
  await editorReady(page);
  await page.getByRole('button', { name: 'Save to account', exact: true }).click();
  await expect.poll(() => Boolean(finishSave)).toBe(true);
  await page.getByRole('button', { name: 'Your projects', exact: true }).click();
  finishSave();
  await expect.poll(() => refreshed).toBe(true);
  await expect(page.getByRole('heading', { name: 'Your projects' })).toBeVisible();
  await expect(page).toHaveURL(/\/$/);
});

test('cloud permalinks preserve device codes, enforce ownership and resolve on a fresh device', async ({ playwright, browser, baseURL }) => {
  const clients = await Promise.all([0, 1].map(() => playwright.request.newContext({
    baseURL, extraHTTPHeaders: { Origin: baseURL },
  })));
  const [owner, stranger] = clients;
  let id;
  let context;
  let ownerName;
  try {
    for (const [index, client] of clients.entries()) {
      const username = `links_${Date.now()}_${index}`;
      if (index === 0) ownerName = username;
      const response = await client.post('/api/register', { data: {
        username, password: 'a-long-test-password-only',
      } });
      expect(response.status(), await response.text()).toBe(201);
    }
    const response = await owner.post('/api/documents', { data: {
      title: 'Cloud title', source: 'Private cloud source', code: 'Test_123',
    } });
    expect(response.status(), await response.text()).toBe(201);
    const document = (await response.json()).document;
    id = document.id;
    expect(document.code).toMatch(/^[A-Za-z0-9_-]{8}$/);
    expect((await owner.get(`/api/documents/by-code/${document.code}`)).status()).toBe(200);
    expect((await stranger.get(`/api/documents/by-code/${document.code}`)).status()).toBe(404);
    expect((await owner.get('/api/documents/by-code/invalid')).status()).toBe(404);
    expect((await owner.post('/api/documents', { data: { title: 'Invalid', source: '', code: 'bad' } })).status()).toBe(400);
    const collided = await stranger.post('/api/documents', { data: { title: 'Collision', source: '', code: document.code } });
    expect(collided.status()).toBe(201);
    const other = (await collided.json()).document;
    expect(other.code).not.toBe(document.code);
    await stranger.delete(`/api/documents/${other.id}`);

    context = await browser.newContext();
    const page = await context.newPage();
    await page.goto(`${baseURL}/documents/stale/${document.code}`);
    await expect(page.getByRole('heading', { name: 'Document unavailable' })).toBeVisible();
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();
    await page.getByLabel('Username', { exact: true }).fill(ownerName);
    await page.getByLabel('Password', { exact: true }).fill('a-long-test-password-only');
    await page.getByRole('dialog').getByRole('button', { name: 'Sign in', exact: true }).click();
    await expectSource(page, 'Private cloud source');
    await expect(page).toHaveURL(new RegExp(`/documents/cloud-title/${document.code}$`));
    await page.reload();
    await expectSource(page, 'Private cloud source');
    await page.getByRole('textbox', { name: 'Document title' }).fill('Cloud renamed');
    await expect(page).toHaveURL(new RegExp(`/documents/cloud-renamed/${document.code}$`));
    await expect(page.getByRole('status').filter({ hasText: 'Saved to your account' })).toBeVisible();
    await page.getByRole('button', { name: 'New document', exact: true }).click();
    await editorReady(page);
    const localCode = new URL(page.url()).pathname.split('/').at(-1);
    await page.getByRole('button', { name: 'Save to account', exact: true }).click();
    await expect(page.getByRole('status').filter({ hasText: 'Saved to your account' })).toBeVisible();
    expect(new URL(page.url()).pathname.split('/').at(-1)).toBe(localCode);
    const list = (await (await owner.get('/api/documents')).json()).documents;
    const linked = list.find(item => item.code === localCode);
    expect(linked).toBeTruthy();
    await owner.delete(`/api/documents/${linked.id}`);
  } finally {
    if (context) await context.close();
    if (id) await owner.delete(`/api/documents/${id}`);
    await Promise.all(clients.map(client => client.dispose()));
  }
});
