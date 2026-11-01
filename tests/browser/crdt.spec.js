import { test, expect } from '@playwright/test';
import { join } from 'node:path';
import { createText, editText, encodeState } from '../../src/crdt.js';
import { editorReady, sourceEditor, expectSource, readSource } from './source-editor.js';

const password = 'crdt-test-password-only';
function state(source, code = crypto.randomUUID().replaceAll('-', '').slice(0, 8)) {
  const doc = createText({ code, source });
  try { return { code, source, crdt_state: encodeState(doc) }; }
  finally { doc.destroy(); }
}
function edit(document, source) {
  const doc = createText(document);
  try {
    editText(doc, source);
    return { ...document, source, crdt_state: encodeState(doc) };
  } finally { doc.destroy(); }
}
async function seed(page, document) {
  await page.addInitScript(document => {
    if (sessionStorage.getItem('crdt-seeded')) return;
    sessionStorage.setItem('crdt-seeded', 'true');
    const request = indexedDB.open('folio-drafts', 1);
    request.onupgradeneeded = () => request.result.createObjectStore('documents', { keyPath: 'id' });
    request.onsuccess = () => {
      const db = request.result;
      const tx = db.transaction('documents', 'readwrite');
      const store = tx.objectStore('documents');
      store.clear();
      store.put(document);
      tx.oncomplete = () => db.close();
    };
  }, document);
}
async function save(page) {
  await page.getByRole('button', { name: 'Save to account', exact: true }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Saved to your account' })).toBeVisible();
}
async function append(page, text) {
  await editorReady(page);
  await sourceEditor(page).press('Control+End');
  await page.keyboard.insertText(text);
  await expect(page.getByRole('status').filter({ hasText: 'Saved on this device' })).toBeVisible();
}

test('two offline devices merge one coded document on reconnect without a conflict dialog', async ({ browser, baseURL }) => {
  const first = await browser.newContext(), second = await browser.newContext();
  const username = `crdt_${Date.now()}`;
  const headers = { Origin: baseURL };
  try {
    const registered = await first.request.post(`${baseURL}/api/register`, { headers, data: { username, password } });
    expect(registered.status()).toBe(201);
    const owner = (await registered.json()).user.id;
    const created = await first.request.post(`${baseURL}/api/documents/sync`, { headers,
      data: { title: 'One convergent paper', ...state('\\documentclass{article}\n\\begin{document}\nShared beginning.\n\\end{document}\n') } });
    expect(created.status(), await created.text()).toBe(201);
    const shared = (await created.json()).document;
    const login = await second.request.post(`${baseURL}/api/login`, { headers, data: { username, password } });
    expect(login.status()).toBe(200);
    const a = await first.newPage(), b = await second.newPage();
    const draft = { ...shared, id: shared.code, cloudId: shared.id, owner, dirty: false };
    await seed(a, draft);
    await seed(b, draft);
    await a.goto('/#workspace');
    await b.goto('/#workspace');
    await expectSource(a, shared.source);
    await expectSource(b, shared.source);
    await first.setOffline(true);
    await second.setOffline(true);
    await a.getByRole('button', { name: 'Your projects', exact: true }).click();
    await a.getByRole('list', { name: 'Projects' }).getByRole('button').filter({ hasText: 'One convergent paper' }).click();
    await expectSource(a, shared.source);
    await append(a, '% Device A.\n');
    await append(b, '% Device B.\n');
    await first.setOffline(false);
    await expect(a.getByRole('status').filter({ hasText: 'Saved to your account' })).toBeVisible();
    await second.setOffline(false);
    await expect.poll(async () => {
      const response = await second.request.get(`${baseURL}/api/documents/${shared.id}`);
      return (await response.json()).document.source;
    }).toMatch(/Device A\.[\s\S]*Device B\.|Device B\.[\s\S]*Device A\./);
    await save(a);
    const converged = (await (await first.request.get(`${baseURL}/api/documents/${shared.id}`)).json()).document.source;
    await expectSource(a, converged);
    await save(b);
    await expectSource(b, converged);
    await expect(a.getByRole('navigation', { name: 'Documents' }).locator('.document-item').filter({ hasText: 'One convergent paper' })).toHaveCount(1);
    await expect(a.getByRole('button', { name: /Open account version/ })).toHaveCount(0);
    expect((await (await first.request.get(`${baseURL}/api/documents`)).json()).documents.filter(item => item.code === shared.code)).toHaveLength(1);
    if (process.env.CRDT_ARTIFACTS) {
      await a.getByRole('button', { name: 'Compile', exact: true }).click();
      await expect(a.locator('.preview-status')).toContainText('Compiled in your browser', { timeout: 60000 });
      await a.screenshot({ path: join(process.env.CRDT_ARTIFACTS, 'crdt-converged.png'), fullPage: true });
    }
  } finally { await first.close(); await second.close(); }
});

test('sign-in automatically merges an unlinked device draft with the same account code', async ({ page, playwright, baseURL }) => {
  const ownerClient = await playwright.request.newContext({ baseURL, extraHTTPHeaders: { Origin: baseURL } });
  const username = `signin_${Date.now()}`;
  try {
    expect((await ownerClient.post('/api/register', { data: { username, password } })).status()).toBe(201);
    const base = state('Shared source.\n');
    const cloud = edit(base, 'Shared source.\nAccount edit.\n');
    const response = await ownerClient.post('/api/documents/sync', { data: { title: 'Sign-in merge', ...cloud } });
    expect(response.status()).toBe(201);
    const shared = (await response.json()).document;
    const local = edit(base, 'Shared source.\nDevice edit.\n');
    await seed(page, { ...local, id: local.code, title: 'Sign-in merge', owner: null, cloudId: null,
      dirty: true, updated_at: Date.now() });
    await page.goto('/#workspace');
    await expectSource(page, local.source);
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();
    await page.getByRole('textbox', { name: 'Username', exact: true }).fill(username);
    await page.getByLabel('Password', { exact: true }).fill(password);
    await page.getByRole('dialog').getByRole('button', { name: 'Sign in', exact: true }).click();
    await expect(page.getByRole('status').filter({ hasText: 'Saved to your account' })).toBeVisible();
    const source = (await (await ownerClient.get(`/api/documents/${shared.id}`)).json()).document.source;
    expect(source).toContain('Account edit.');
    expect(source).toContain('Device edit.');
    await expectSource(page, source);
    await expect(page.getByRole('navigation', { name: 'Documents' }).locator('.document-item')).toHaveCount(1);
    expect((await (await ownerClient.get('/api/documents')).json()).documents).toHaveLength(1);
  } finally { await ownerClient.dispose(); }
});

test('synchronization validates state snapshots, retains ownership and merges overlapping saves atomically', async ({ playwright, baseURL }) => {
  const a = await playwright.request.newContext({ baseURL, extraHTTPHeaders: { Origin: baseURL } });
  const b = await playwright.request.newContext({ baseURL, extraHTTPHeaders: { Origin: baseURL } });
  try {
    for (const [index, client] of [a, b].entries())
      expect((await client.post('/api/register', { data: { username: `sync_${Date.now()}_${index}`, password } })).status()).toBe(201);
    const base = state('base');
    const created = await a.post('/api/documents/sync', { data: { ...base, title: 'Atomic' } });
    expect(created.status()).toBe(201);
    const document = (await created.json()).document;
    expect((await b.post('/api/documents/sync', { data: { ...base, title: 'Foreign' } })).status()).toBe(409);
    expect((await a.post('/api/documents/sync', { data: { ...base, title: 'Invalid', source: 'mismatch' } })).status()).toBe(400);
    expect((await a.post('/api/documents/sync', { data: { ...base, title: 'Invalid', crdt_state: '%%%%' } })).status()).toBe(400);
    const edits = [edit(base, 'Abase'), edit(base, 'baseB')];
    const results = await Promise.all(edits.map(item => a.post('/api/documents/sync', { data: { ...item, title: 'Atomic' } })));
    for (const response of results) expect(response.status(), await response.text()).toBe(200);
    const latest = (await (await a.get(`/api/documents/${document.id}`)).json()).document;
    expect(latest.source).toBe('AbaseB');
    const sameCode = await a.post('/api/documents', { data: { code: base.code, title: 'Atomic', source: latest.source } });
    expect(sameCode.status()).toBe(200);
    expect((await sameCode.json()).document.id).toBe(document.id);
    expect((await (await a.get('/api/documents')).json()).documents).toHaveLength(1);
    const offline = edit(latest, 'ZAbaseB');
    const legacyWrite = await a.put(`/api/documents/${document.id}`, {
      data: { title: 'Atomic', source: 'AbaseB!', revision: latest.revision },
    });
    expect(legacyWrite.status()).toBe(200);
    const resumed = await a.post('/api/documents/sync', { data: { ...offline, title: 'Atomic' } });
    expect(resumed.status()).toBe(200);
    expect((await resumed.json()).document.source).toBe('ZAbaseB!');
  } finally { await a.dispose(); await b.dispose(); }
});

test('legacy linked device drafts adopt the migrated account code and retain both sources', async ({ page, baseURL }) => {
  const registered = await page.request.post('/api/register', {
    headers: { Origin: baseURL }, data: { username: `legacy_${Date.now()}`, password },
  });
  expect(registered.status()).toBe(201);
  const owner = (await registered.json()).user.id;
  const created = await page.request.post('/api/documents', {
    headers: { Origin: baseURL }, data: { title: 'Legacy merge', source: 'Shared legacy beginning.\nCloud change.\nShared end.' },
  });
  expect(created.status()).toBe(201);
  const cloud = (await created.json()).document;
  await seed(page, { id: 'legacy-local', title: 'Legacy merge',
    source: 'Shared legacy beginning.\nLocal change.\nShared end.',
    owner, cloudId: cloud.id, revision: 1, updated_at: Date.now(), dirty: true });
  await page.goto('/#workspace');
  await expect(page.getByRole('status').filter({ hasText: 'Saved to your account' })).toBeVisible();
  const merged = (await (await page.request.get(`/api/documents/${cloud.id}`)).json()).document;
  expect(merged.source).toContain('Cloud change.');
  expect(merged.source).toContain('Local change.');
  expect(merged.source.split('Shared legacy beginning.')).toHaveLength(2);
  await expectSource(page, merged.source);
  expect(new URL(page.url()).pathname.split('/').at(-1)).toBe(cloud.code);
  expect((await (await page.request.get('/api/documents')).json()).documents).toHaveLength(1);
});

test('same-device tabs merge IndexedDB edits and notify each other without polling', async ({ page, context }) => {
  const base = state('Shared tab source.\n');
  await seed(page, { ...base, id: base.code, title: 'One tab document',
    owner: null, cloudId: null, updated_at: Date.now(), dirty: true });
  await page.goto('/#workspace');
  await expectSource(page, base.source);
  const other = await context.newPage();
  await other.goto(page.url());
  await expectSource(other, base.source);
  await context.setOffline(true);
  await Promise.all([append(page, 'Tab A.\n'), append(other, 'Tab B.\n')]);
  await expect.poll(() => readSource(page)).toContain('Tab A.');
  await expect.poll(() => readSource(page)).toContain('Tab B.');
  const merged = await readSource(page);
  await expectSource(other, merged);
  await context.setOffline(false);
  await page.reload();
  await expectSource(page, merged);
  await other.close();
});

test('Monaco CRLF normalization keeps source and CRDT range offsets consistent', async ({ page, baseURL }) => {
  const registered = await page.request.post('/api/register', {
    headers: { Origin: baseURL }, data: { username: `crlf_${Date.now()}`, password },
  });
  expect(registered.status()).toBe(201);
  const owner = (await registered.json()).user.id;
  const base = state('First line.\r\nSecond line.\r\n');
  const response = await page.request.post('/api/documents/sync', {
    headers: { Origin: baseURL }, data: { ...base, title: 'Windows source' },
  });
  const document = (await response.json()).document;
  await seed(page, { ...document, id: document.code, cloudId: document.id, owner, dirty: false });
  await page.goto('/#workspace');
  await expectSource(page, base.source.replaceAll('\r\n', '\n'));
  await editorReady(page);
  await sourceEditor(page).press('Control+End');
  await page.keyboard.insertText('Final line.');
  await save(page);
  const expected = 'First line.\nSecond line.\nFinal line.';
  await expectSource(page, expected);
  expect((await (await page.request.get(`/api/documents/${document.id}`)).json()).document.source).toBe(expected);
});
