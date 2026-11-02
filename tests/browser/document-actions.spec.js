import { test, expect } from '@playwright/test';

async function mockAccount(page) {
  const saved = new Map(), writes = [], deletes = [];
  let releaseSaves, releaseDeletes;
  let blocked = true, deleting = false, failDeletion = false, failSaveResponse = false;
  const saveGate = new Promise(done => { releaseSaves = () => { blocked = false; done(); }; });
  const deleteGate = new Promise(done => { releaseDeletes = () => { deleting = false; done(); }; });
  await page.route('**/api/me', route => route.fulfill({ json: { user: { id: 'action-owner', username: 'writer' } } }));
  await page.route('**/api/documents', route => route.fulfill({ json: { documents: [...saved.values()] } }));
  await page.route('**/api/documents/sync', async route => {
    const posted = route.request().postDataJSON();
    writes.push(posted);
    if (blocked) await saveGate;
    const document = { ...posted, id: posted.code, revision: 1, updated_at: Date.now() };
    saved.set(posted.code, document);
    if (failSaveResponse) return route.fulfill({ status: 503, json: { error: 'Response lost after save' } });
    await route.fulfill({ json: { document } });
  });
  await page.route(/\/api\/documents\/(?:by-code\/)?[^/]+$/, async route => {
    const id = route.request().url().split('/').at(-1);
    if (id === 'sync') return route.fallback();
    if (route.request().method() === 'GET') return route.fulfill({ json: { document: saved.get(id) } });
    deletes.push(id);
    if (deleting) await deleteGate;
    if (failDeletion) return route.fulfill({ status: 503, json: { error: 'Temporary outage' } });
    saved.delete(id);
    await route.fulfill({ json: { ok: true } });
  });
  await page.goto('/');
  await page.evaluate(() => latex.ready());
  return { saved, writes, deletes, releaseSaves, releaseDeletes,
    holdDeletes: () => { deleting = true; }, failDeletes: value => { failDeletion = value; },
    failSaveResponse: value => { failSaveResponse = value; } };
}

test('five creations stay usable and all reach the account while earlier saves wait', async ({ page }) => {
  const account = await mockAccount(page), created = [];
  for (let index = 0; index < 5; index++) {
    created.push(await page.evaluate(index => latex.create({ title: `Keep ${index}`, source: `keep ${index}` }), index));
    await page.evaluate(() => latex.append('\nlatest'));
  }
  await expect.poll(() => account.writes.length).toBeGreaterThan(0);
  await expect(page.getByRole('button', { name: 'New document', exact: true })).toBeEnabled();
  await expect(page.getByRole('button', { name: 'Share', exact: true })).toBeEnabled();
  await expect(page.getByRole('textbox', { name: 'Document title' })).toBeEnabled();
  expect(await page.evaluate(() => latex.read())).toBe('keep 4\nlatest');
  account.releaseSaves();
  await expect.poll(() => created.filter(item => account.saved.get(item.code)?.source.endsWith('\nlatest')).length).toBe(5);
  for (const document of created) expect([...account.saved.values()].filter(item => item.code === document.code)).toHaveLength(1);
});

test('five deletes wait for server confirmation without locking other work', async ({ page }) => {
  const account = await mockAccount(page), created = [];
  account.releaseSaves();
  for (let index = 0; index < 5; index++) {
    created.push(await page.evaluate(index => latex.create({ title: `Delete ${index}`, source: `delete ${index}` }), index));
    await page.evaluate(() => latex.save());
  }
  account.holdDeletes();
  await page.evaluate(codes => { window.pendingDeletes = codes.map(code => latex.remove(code, { confirm: true })); }, created.map(item => item.code));
  const other = await page.evaluate(() => latex.create({ title: 'Unblocked work', source: 'other' }));
  await page.evaluate(() => latex.append('\nstill editing'));
  await page.getByRole('button', { name: 'Compile', exact: true }).click();
  await expect(page.getByRole('button', { name: 'New document', exact: true })).toBeEnabled();
  account.releaseSaves();
  await expect.poll(() => account.deletes.length).toBeGreaterThan(0);
  for (const document of created)
    expect(await page.evaluate(code => latex.list().some(item => item.code === code), document.code)).toBe(true);
  account.releaseDeletes();
  await page.evaluate(() => Promise.all(window.pendingDeletes));
  expect(await page.evaluate(() => latex.current().id)).toBe(other.id);
  expect(await page.evaluate(() => latex.read())).toBe('other\nstill editing');
  for (const document of created) {
    expect(await page.evaluate(code => latex.list().some(item => item.code === code), document.code)).toBe(false);
    expect(account.saved.has(document.code)).toBe(false);
  }
  await page.reload();
  await page.evaluate(() => latex.ready());
  for (const document of created)
    expect(await page.evaluate(code => latex.list().some(item => item.code === code), document.code)).toBe(false);
});

test('delete waits behind an in-flight first upload while another document can be edited', async ({ page }) => {
  const account = await mockAccount(page);
  const document = await page.evaluate(() => latex.create({ title: 'Uploading', source: 'source' }));
  await expect.poll(() => account.writes.some(item => item.code === document.code)).toBe(true);
  await page.evaluate(() => { window.queuedSave = latex.save(); });
  await page.evaluate(code => { window.removal = latex.remove(code, { confirm: true }); }, document.code);
  const other = await page.evaluate(() => latex.create({ title: 'Other', source: 'other' }));
  await page.evaluate(() => latex.append('\nedit'));
  expect(account.deletes).not.toContain(document.code);
  account.releaseSaves();
  await page.evaluate(() => window.removal);
  expect(typeof (await page.evaluate(() => window.queuedSave)).ok).toBe('boolean');
  expect(account.deletes).toContain(document.code);
  expect(account.saved.has(document.code)).toBe(false);
  expect(await page.evaluate(() => latex.current().id)).toBe(other.id);
  expect(await page.evaluate(() => latex.read())).toBe('other\nedit');
});

test('concurrent creates retain five distinct documents and return their own identities', async ({ page }) => {
  const account = await mockAccount(page);
  const documents = await page.evaluate(() => Promise.all(Array.from({ length: 5 }, (_, index) =>
    latex.create({ title: `Concurrent ${index}`, source: `source ${index}` }))));
  expect(new Set(documents.map(item => item.id)).size).toBe(5);
  expect(documents.map(item => item.title)).toEqual(Array.from({ length: 5 }, (_, index) => `Concurrent ${index}`));
  account.releaseSaves();
  await expect.poll(() => documents.filter(item => account.saved.has(item.code)).length).toBe(5);
});

test('deleting after a lost first-upload response finds and deletes the account document', async ({ page }) => {
  const account = await mockAccount(page);
  account.releaseSaves();
  account.failSaveResponse(true);
  const document = await page.evaluate(() => latex.create({ title: 'Uncertain upload', source: 'source' }));
  await expect(page.evaluate(() => latex.save())).rejects.toThrow('Response lost after save');
  expect(account.saved.has(document.code)).toBe(true);
  await page.evaluate(code => latex.remove(code, { confirm: true }), document.code);
  expect(account.saved.has(document.code)).toBe(false);
});

test('failed deletion retains the item and retries without switching current work', async ({ page }) => {
  const account = await mockAccount(page);
  account.releaseSaves();
  const document = await page.evaluate(() => latex.create({ title: 'Delete retry', source: 'draft' }));
  await page.evaluate(() => latex.save());
  account.failDeletes(true);
  await expect(page.evaluate(code => latex.remove(code, { confirm: true }), document.code)).rejects.toThrow('Temporary outage');
  expect(await page.evaluate(code => latex.list().some(item => item.code === code), document.code)).toBe(true);
  const other = await page.evaluate(() => latex.create({ title: 'Keep working', source: 'other' }));
  account.failDeletes(false);
  await page.getByRole('button', { name: 'Retry delete' }).click();
  await expect.poll(() => account.saved.has(document.code)).toBe(false);
  expect(await page.evaluate(() => latex.current().id)).toBe(other.id);
});
