import { test, expect } from '@playwright/test';
import { editorReady, expectSource } from './source-editor.js';

const paper = String.raw`\documentclass{article}
\begin{document}
\section{Agent API}\label{api}
See section \ref{api}.
\end{document}`;

test('window.latex opens, switches, reads, edits, compiles and reports logs and timings', async ({ page }) => {
  const consoleErrors = [];
  const expected = [/status of 401/, /^Compilation failed, with status code 1$/];
  page.on('console', message => {
    if (message.type() === 'error' && !expected.some(pattern => pattern.test(message.text()))) consoleErrors.push(message.text());
  });
  await page.goto('/');
  const ready = await page.evaluate(() => latex.ready());
  expect(ready.view).toBe('projects');
  expect(await page.evaluate(() => latex.help())).toContain('latex.compile');

  const first = await page.evaluate(source => latex.create({ title: 'API alpha', source }), paper);
  expect(first).toMatchObject({ title: 'API alpha', lines: 5 });
  await page.evaluate(() => latex.create({ title: 'API beta', source: 'beta' }));
  expect(await page.evaluate(() => latex.read())).toBe('beta');
  const list = await page.evaluate(() => latex.list());
  expect(list.filter(item => item.title.startsWith('API ')).map(item => [item.title, item.local, item.cloud]))
    .toEqual(expect.arrayContaining([['API alpha', true, false], ['API beta', true, false]]));
  expect(list.find(item => item.current).title).toBe('API beta');

  expect(await page.evaluate(() => latex.open('API alpha'))).toMatchObject({ id: first.id, title: 'API alpha' });
  expect(first.code).toMatch(/^[A-Za-z0-9_-]{8}$/);
  expect(first.url).toBe(`/documents/api-alpha/${first.code}`);
  await expect(page).toHaveURL(new RegExp(`${first.url}$`));
  await page.evaluate(() => latex.open('API beta'));
  expect(await page.evaluate(code => latex.open(code), first.code)).toMatchObject({ id: first.id });
  await expect(page).toHaveURL(new RegExp(`${first.url}$`));
  await page.goBack();
  await expect.poll(() => page.evaluate(() => latex.current().title)).toBe('API beta');
  await page.goForward();
  await expect.poll(() => page.evaluate(() => latex.current().title)).toBe('API alpha');
  await editorReady(page);
  expect(await page.evaluate(() => latex.read({ from: 3, to: 3 }))).toBe(String.raw`\section{Agent API}\label{api}`);
  expect(await page.evaluate(() => latex.find('\\ref').map(match => [match.line, match.column]))).toEqual([[4, 13]]);

  await page.evaluate(() => {
    latex.replace('Agent API', 'Console API');
    latex.insertLines(4, 'Inserted line.');
    latex.replaceLines(5, 5, 'See section \\ref{api} again.');
  });
  const edited = paper.replace('Agent API', 'Console API').replace('See section \\ref{api}.', 'Inserted line.\nSee section \\ref{api} again.');
  await expectSource(page, edited);
  await page.evaluate(() => latex.undo());
  await expectSource(page, edited.replace(' again.', '.'));
  await page.evaluate(() => latex.redo());
  expect(await page.evaluate(() => latex.read())).toBe(edited);
  await expect(page.getByRole('status').filter({ hasText: 'Saved on this device' })).toBeVisible();

  const saved = await page.evaluate(() => latex.save());
  expect(saved).toMatchObject({ ok: true, local: true, cloud: false });
  await page.evaluate(() => latex.rename('API alpha renamed'));
  await expect(page.getByRole('textbox', { name: 'Document title' })).toHaveValue('API alpha renamed');

  const compiled = await page.evaluate(async () => {
    const events = [];
    const off = latex.on('compile', detail => events.push(detail.ok));
    const result = await latex.compile();
    off();
    return { result, events };
  });
  expect(compiled.events).toEqual([true]);
  expect(compiled.result).toMatchObject({ ok: true, errors: [], upToDate: true });
  expect(compiled.result.timings.compilationMs).toBeGreaterThan(0);
  const preview = await page.evaluate(() => latex.preview());
  expect(preview).toMatchObject({ ok: true, pages: 1 });
  await expect(page.locator('.pdf-viewer:not(.pending) canvas')).toHaveCount(1);
  expect(await page.evaluate(() => latex.pdf())).toMatchObject({ pages: 1, upToDate: true });
  const exported = await page.evaluate(() => latex.exportPdf());
  expect(exported.base64.startsWith('JVBERi')).toBe(true);
  expect(exported.bytes).toBeGreaterThan(1000);
  expect(await page.evaluate(() => latex.log().text)).toContain('Output written');
  const timings = await page.evaluate(() => latex.timings());
  expect(timings.compile.totalMs).toBeGreaterThan(0);
  expect(timings.engineStartupMs).toBeGreaterThan(0);
  expect(timings.localSaveMs).toBeGreaterThanOrEqual(0);

  await page.evaluate(() => latex.replace('\\end{document}', '\\undefinedmacro\n\\end{document}'));
  const failed = await page.evaluate(() => latex.compile());
  expect(failed.ok).toBe(false);
  expect(failed.errors[0]).toMatchObject({ message: 'Undefined control sequence.', line: 6 });
  expect(await page.evaluate(() => latex.log().errors[0].line)).toBe(6);
  expect((await page.evaluate(() => latex.status())).previewUpToDate).toBe(false);

  await expect(page.evaluate(() => latex.remove('API beta'))).rejects.toThrow(/confirm: true/);
  await page.evaluate(() => latex.remove('API beta', { confirm: true }));
  expect(await page.evaluate(() => latex.list().some(item => item.title === 'API beta'))).toBe(false);
  await expect(page.evaluate(() => latex.setSource('bad\u0000'))).rejects.toThrow(/control characters/);
  await expect(page.evaluate(() => latex.open('missing'))).rejects.toThrow(/No document matches/);
  expect(consoleErrors).toEqual([]);
});

test('window.latex save awaits the account request and Help documents the API', async ({ page }) => {
  const requests = [];
  await page.route('**/api/me', route => route.fulfill({ json: { user: { id: 'owner', username: 'writer' } } }));
  await page.route('**/api/documents', route => {
    requests.push(route.request().method());
    if (route.request().method() === 'GET') return route.fulfill({ json: { documents: [] } });
    const posted = route.request().postDataJSON();
    return route.fulfill({ json: { document: { id: 'cloud-1', code: posted.code, revision: 1 } } });
  });
  await page.route('**/api/documents/cloud-1', route => {
    requests.push(route.request().method());
    return route.fulfill({ json: { revision: 2 } });
  });
  await page.goto('/');
  await page.evaluate(() => latex.ready());
  const first = await page.evaluate(() => latex.save());
  expect(first).toMatchObject({ ok: true, cloud: true, cloudId: 'cloud-1', revision: 1 });
  await page.evaluate(() => latex.append('\n% more'));
  const second = await page.evaluate(() => latex.save());
  expect(second).toMatchObject({ ok: true, cloudId: 'cloud-1', revision: 2, dirty: false });
  expect(requests).toContain('POST');
  expect(requests).toContain('PUT');
  expect((await page.evaluate(() => latex.timings())).accountSaveRoundTripMs).toBeGreaterThanOrEqual(0);
  expect(await page.evaluate(() => latex.list()[0])).toMatchObject({ cloudId: 'cloud-1', local: true });

  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole('button', { name: 'Help', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Workspace help' });
  await expect(dialog.getByRole('heading', { name: 'JavaScript API for agents' })).toBeVisible();
  await dialog.getByText(/^All \d+ methods$/).click();
  await expect(dialog.getByText('latex.compile({ force? })')).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(390);
});
