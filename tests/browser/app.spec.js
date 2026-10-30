import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { sourceEditor, editorReady, fillSource, expectSource } from './source-editor.js';

const source = String.raw`\documentclass{article}
\usepackage{amsmath}
\begin{document}
\section{A real browser PDF}
Hello from KhanhhNeLatex.
\[ E = mc^2 \]
\end{document}`;

test('browser editor compiles real PDF locally, exports and preserves drafts without typing API calls', async ({ page }) => {
  const errors = [];
  const externalRequests = [];
  const writes = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => {
    if (request.url().startsWith('http') && new URL(request.url()).origin !== new URL(test.info().project.use.baseURL).origin)
      externalRequests.push(request.url());
    if (request.url().includes('/api/') && request.method() !== 'GET') writes.push(request.url());
  });
  await page.goto('/#workspace');
  const editor = page.getByRole('textbox', { name: 'LaTeX source', exact: true });
  await editorReady(page);
  await fillSource(page, source);
  await page.getByRole('textbox', { name: 'Document title' }).fill('Browser test');
  await expect(page.getByRole('status').filter({ hasText: 'Saved on this device' })).toBeVisible();
  const exportSource = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export .tex' }).click();
  expect(await readFile(await (await exportSource).path(), 'utf8')).toBe(source);
  await page.reload();
  await expectSource(page, source);
  const before = Date.now();
  await page.getByRole('button', { name: 'Compile', exact: true }).click();
  await editor.press('Control+End');
  await editor.press('Space');
  await expectSource(page, source + ' ');
  await expect(page.locator('.preview-status')).toContainText('Compiled in your browser', { timeout: 60000 });
  await expect(page.locator('.preview-status')).toContainText('Preview is out of date');
  const iframe = page.locator('iframe[title="Compiled PDF"]');
  await expect(iframe).toBeVisible();
  expect(await iframe.getAttribute('src')).toMatch(/^blob:/);
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export PDF' }).click();
  const pdf = await readFile(await (await download).path());
  expect(pdf.subarray(0, 5).toString()).toBe('%PDF-');
  expect(pdf.length).toBeGreaterThan(5000);
  expect(writes).toEqual([]);
  expect(externalRequests).toEqual([]);
  expect(errors).toEqual([]);
  console.log(`Real two-pass compilation and edit completed in ${Date.now() - before}ms; PDF ${pdf.length} bytes; zero API writes or external requests.`);
});

test('invalid input, cancellation, document selection and mobile layout behave safely', async ({ page }) => {
  await page.goto('/#workspace');
  const editor = page.getByRole('textbox', { name: 'LaTeX source', exact: true });
  await editorReady(page);
  await page.locator('input[type=file]').setInputFiles({ name: 'bad.tex', mimeType: 'text/plain', buffer: Buffer.from([0, 1, 2, 255]) });
  await expect(page.locator('.error-banner')).toContainText('not valid UTF-8');
  await page.getByRole('button', { name: 'Dismiss error' }).click();
  await fillSource(page, String.raw`\documentclass{article}\begin{document}\notacommand\end{document}`);
  await page.getByRole('button', { name: 'Compile', exact: true }).click();
  await expect(page.getByText('LaTeX could not compile.', { exact: false })).toBeVisible({ timeout: 60000 });
  await expect(page.locator('.compile-log')).toContainText('Undefined control sequence');
  await fillSource(page, String.raw`\documentclass{article}\begin{document}\loop\iftrue\repeat\end{document}`);
  await page.getByRole('button', { name: 'Compile', exact: true }).click();
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(page.getByText('Compilation cancelled.', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'New document' }).click();
  await expect(page.getByRole('navigation', { name: 'Local documents' }).getByRole('button')).toHaveCount(2);
  await fillSource(page, 'latest unsaved change');
  await page.getByRole('navigation', { name: 'Local documents' }).getByRole('button').first().click();
  await expectSource(page, 'latest unsaved change');
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(editor).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(390);
  await page.getByRole('button', { name: 'PDF preview', exact: true }).click();
  await expect(page.getByRole('region', { name: 'PDF preview' })).toBeVisible();
});

test('D1 auth, ownership, CSRF, revisions, text validation and session invalidation', async ({ playwright, baseURL }) => {
  const contexts = await Promise.all([0, 1].map(() => playwright.request.newContext({
    baseURL, extraHTTPHeaders: { Origin: baseURL },
  })));
  const [alice, bob] = contexts;
  let docId;
  try {
    for (const [index, client] of contexts.entries()) {
      const start = Date.now();
      const response = await client.post('/api/register', { data: { username: `e2e_${Date.now()}_${index}`, password: 'a-long-test-password-only' } });
      expect(response.status(), await response.text()).toBe(201);
      console.log(`Registration ${index}: ${Date.now() - start}ms`);
      const session = (await client.storageState()).cookies[0];
      expect(session.httpOnly).toBe(true);
      expect(session.sameSite).toBe('Strict');
      if (baseURL.startsWith('https')) expect(session.secure).toBe(true);
    }
    const create = await alice.post('/api/documents', { data: { title: 'Ownership test', source } });
    expect(create.status(), await create.text()).toBe(201);
    docId = (await create.json()).document.id;
    for (const method of ['get', 'put', 'delete']) {
      const response = await bob[method](`/api/documents/${docId}`, method === 'put' ? { data: { title: 'Stolen', source, revision: 1 } } : {});
      expect(response.status()).toBe(404);
    }
    expect((await alice.post('/api/documents', { data: { title: 'Binary', source: '\0' } })).status()).toBe(400);
    expect((await alice.post('/api/documents', { data: { title: 'Large', source: 'x'.repeat(100001) } })).status()).toBe(400);
    const updated = await alice.put(`/api/documents/${docId}`, { data: { title: 'Changed', source: 'changed', revision: 1 } });
    expect(updated.status()).toBe(200);
    expect((await updated.json()).revision).toBe(2);
    expect((await alice.put(`/api/documents/${docId}`, { data: { title: 'Conflict', source, revision: 1 } })).status()).toBe(409);
    const read = await alice.get(`/api/documents/${docId}`);
    expect((await read.json()).document.source).toBe('changed');
    expect((await alice.delete(`/api/documents/${docId}`, { headers: { Origin: 'https://evil.invalid' } })).status()).toBe(403);
    expect((await alice.delete(`/api/documents/${docId}`)).status()).toBe(200);
    docId = null;
    expect((await alice.post('/api/logout', { data: {} })).status()).toBe(200);
    expect((await alice.get('/api/me')).status()).toBe(401);
  } finally {
    if (docId) await alice.delete(`/api/documents/${docId}`);
    await Promise.all(contexts.map(client => client.dispose()));
  }
});
