import { test, expect } from '@playwright/test';

const password = 'starter-signin-test-password';
const accountSource = '\\documentclass{article}\n\\begin{document}Account paper.\\end{document}';
const testIp = '192.0.2.31';
test.use({ extraHTTPHeaders: { 'CF-Connecting-IP': testIp } });

async function localDrafts(page) {
  return page.evaluate(() => new Promise((resolve, reject) => {
    const request = indexedDB.open('folio-drafts');
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const db = request.result;
      const tx = db.transaction('documents', 'readonly');
      const read = tx.objectStore('documents').getAll();
      tx.oncomplete = () => { resolve(read.result); db.close(); };
      tx.onerror = () => reject(tx.error);
    };
  }));
}

for (const mode of ['ui', 'restore', 'reconnect']) {
  test(`untouched default never uploads with existing account docs (${mode}, permalink and API save)`, async ({ page, playwright, baseURL }) => {
    const owner = await playwright.request.newContext({ baseURL, extraHTTPHeaders: { Origin: baseURL, 'CF-Connecting-IP': testIp } });
    const username = `zz-test-${process.env.STARTER_TEST_RUN || Date.now()}-${mode}`;
    const uploads = [];
    try {
      expect((await owner.post('/api/register', { data: { username, password } })).status()).toBe(201);
      const created = await owner.post('/api/documents', { data: { title: 'Most recent account paper', source: accountSource } });
      expect(created.status()).toBe(201);
      const remote = (await created.json()).document;
      await page.goto('/#workspace');
      await page.evaluate(() => latex.ready());
      const original = await page.evaluate(() => latex.current());
      await page.goto(original.url);
      await page.evaluate(() => latex.ready());
      let releaseList;
      let listStarted = false;
      const listGate = new Promise(resolve => { releaseList = resolve; });
      await page.route('**/api/documents', async route => {
        if (route.request().method() === 'GET' && !listStarted) {
          listStarted = true;
          await listGate;
        }
        await route.continue();
      });
      page.on('request', request => {
        if (request.url().endsWith('/api/documents/sync')) uploads.push(request.postDataJSON().code);
      });
      if (mode === 'ui') {
        await page.getByRole('button', { name: 'Sign in', exact: true }).click();
        await page.getByLabel('Username', { exact: true }).fill(username);
        await page.getByLabel('Password', { exact: true }).fill(password);
        await page.getByRole('dialog').getByRole('button', { name: 'Sign in', exact: true }).click();
      } else {
        expect((await page.request.post('/api/login', { headers: { Origin: baseURL }, data: { username, password } })).status()).toBe(200);
        if (mode === 'restore') await page.reload();
        else await page.evaluate(() => window.dispatchEvent(new Event('online')));
      }
      await expect.poll(() => listStarted).toBe(true);
      // A manual API save and debounce can both arrive before the list returns.
      if (mode !== 'restore') await page.evaluate(() => {
        window.starterSave = latex.save();
      });
      await page.waitForTimeout(1000);
      expect(uploads).not.toContain(original.code);
      releaseList();
      await expect.poll(() => page.evaluate(() => latex.current()?.code)).toBe(remote.code);
      await page.evaluate(() => latex.ready());
      if (mode !== 'restore') await page.evaluate(() => window.starterSave);
      await page.evaluate(() => latex.save());
      expect(await page.evaluate(() => latex.read())).toBe(accountSource);
      expect(uploads).not.toContain(original.code);
      expect((await (await owner.get('/api/documents')).json()).documents.map(item => item.code)).toEqual([remote.code]);
      expect((await localDrafts(page)).some(item => item.code === original.code)).toBe(false);
      expect(await page.evaluate(code => latex.list().some(item => item.code === code), original.code)).toBe(false);
      await page.reload();
      await page.evaluate(() => latex.ready());
      expect(await page.evaluate(() => latex.current().code)).toBe(remote.code);
      expect(uploads).not.toContain(original.code);
    } finally { await owner.dispose(); }
  });
}

for (const changed of [true, false]) {
  test(`${changed ? 'changed default with existing docs' : 'untouched default with empty account'} is stored on sign-in`, async ({ page, playwright, baseURL }) => {
    const owner = await playwright.request.newContext({ baseURL, extraHTTPHeaders: { Origin: baseURL, 'CF-Connecting-IP': testIp } });
    const username = `zz-test-${process.env.STARTER_TEST_RUN || Date.now()}-${changed ? 'edit' : 'empty'}`;
    try {
      expect((await owner.post('/api/register', { data: { username, password } })).status()).toBe(201);
      if (changed) expect((await owner.post('/api/documents', {
        data: { title: 'Existing account paper', source: accountSource },
      })).status()).toBe(201);
      await page.goto('/');
      await page.evaluate(() => latex.ready());
      if (changed) await page.evaluate(() => latex.setSource(latex.read() + '\n% Intentional edit.\n'));
      const original = await page.evaluate(() => ({ ...latex.current(), source: latex.read() }));
      await page.getByRole('button', { name: 'Sign in', exact: true }).click();
      await page.getByLabel('Username', { exact: true }).fill(username);
      await page.getByLabel('Password', { exact: true }).fill(password);
      await page.getByRole('dialog').getByRole('button', { name: 'Sign in', exact: true }).click();
      await expect.poll(async () => (await (await owner.get('/api/documents')).json()).documents.length).toBe(changed ? 2 : 1);
      const remote = await owner.get(`/api/documents/by-code/${original.code}`);
      expect(remote.status()).toBe(200);
      expect((await remote.json()).document.source).toBe(original.source);
      await expect.poll(async () => (await localDrafts(page)).some(item => item.code === original.code && item.owner)).toBe(true);
    } finally { await owner.dispose(); }
  });
}

test('a fresh device preserves the requested account permalink instead of opening the newest paper', async ({ page }) => {
  const requested = { id: 'older', code: 'olderdoc', title: 'Requested paper', source: accountSource, revision: 1, updated_at: 1 };
  const newest = { id: 'newest', code: 'newest01', title: 'Most recent paper', revision: 1, updated_at: 2 };
  const uploads = [];
  await page.route('**/api/me', route => route.fulfill({ json: { user: { id: 'owner', username: 'writer' } } }));
  await page.route('**/api/documents', route => route.fulfill({ json: { documents: [newest, requested] } }));
  await page.route('**/api/documents/by-code/olderdoc', route => route.fulfill({ json: { document: requested } }));
  await page.route('**/api/documents/sync', route => {
    const body = route.request().postDataJSON();
    uploads.push(body.code);
    return route.fulfill({ json: { document: { ...requested, ...body } } });
  });
  await page.goto('/documents/requested-paper/olderdoc');
  await page.evaluate(() => latex.ready());
  await expect.poll(() => page.evaluate(() => latex.current()?.code)).toBe(requested.code);
  expect(await page.evaluate(() => latex.read())).toBe(accountSource);
  expect((await localDrafts(page)).every(item => item.code === requested.code)).toBe(true);
  expect(uploads.every(code => code === requested.code)).toBe(true);
});
