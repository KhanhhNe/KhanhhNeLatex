import { test, expect } from '@playwright/test';
import { editorReady, sourceEditor, fillSource, expectSource, readSource } from './source-editor.js';

async function nativeState(page) {
  return page.evaluate(async () => {
    const url = performance.getEntriesByType('resource').map(entry => entry.name)
      .find(url => /\/assets\/monaco-[^/]+\.js$/.test(url));
    const exports = await import(url);
    const monaco = Object.values(exports).find(value => value.editor?.getEditors);
    const editor = monaco.editor.getEditors()[0];
    return {
      source: editor.getValue(),
      selections: editor.getSelections(),
      selectionTexts: editor.getSelections().map(selection => editor.getModel().getValueInRange(selection)),
      actions: editor.getSupportedActions().map(action => action.id),
      wrap: editor.getOption(monaco.editor.EditorOption.wordWrap),
    };
  });
}

const expectNativeSource = async (page, source) =>
  expect.poll(async () => (await nativeState(page)).source).toBe(source);

test('Monaco preserves controlled editing, selection, undo, full clipboard and original LaTeX highlighting', async ({ page }) => {
  const external = [], errors = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => {
    if (/^https?:/.test(request.url()) && new URL(request.url()).origin !== new URL(test.info().project.use.baseURL).origin)
      external.push(request.url());
  });
  await page.goto('/#workspace', { waitUntil: 'domcontentloaded' });
  await editorReady(page);
  await expect(page.locator('.latex-editor')).toHaveAttribute('data-language', 'latex');
  const source = '\\section{Original}\n% a comment\nText with $x^2$.';
  await fillSource(page, source);
  await expectSource(page, source);
  await expect(page.locator('.view-lines')).toContainText('\\section');
  const tokenColors = await page.locator('.view-lines span').evaluateAll(spans =>
    [...new Set(spans.filter(span => span.textContent.trim()).map(span => getComputedStyle(span).color))]);
  expect(tokenColors.length).toBeGreaterThanOrEqual(3);
  expect(tokenColors).toEqual(expect.arrayContaining([
    'rgb(160, 212, 206)', 'rgb(228, 209, 139)', 'rgb(199, 169, 232)', 'rgb(149, 162, 171)',
  ]));
  await expect(page.locator('.monaco-editor')).toHaveCSS('background-color', 'rgb(24, 32, 39)');
  await expect(page.locator('.monaco-editor')).toHaveCount(1);
  await sourceEditor(page).press('Control+End');
  await page.keyboard.insertText(' Added');
  await page.getByRole('textbox', { name: 'Document title' }).fill('Rerender without replacing the editor');
  await sourceEditor(page).press('Control+z');
  await expectSource(page, source);
  await sourceEditor(page).press('Control+Shift+z');
  await expectSource(page, source + ' Added');
  await page.evaluate(() => navigator.clipboard.writeText('\\textbf{Full paste}\nsecond line'));
  await sourceEditor(page).press('Control+a');
  await sourceEditor(page).press('Control+v');
  await expect(page.locator('.view-lines')).toContainText('Full paste');
  await expectSource(page, '\\textbf{Full paste}\nsecond line');
  await expect(page.getByRole('status').filter({ hasText: 'Saved on this device' })).toBeVisible();
  await page.reload();
  await expectSource(page, '\\textbf{Full paste}\nsecond line');
  await sourceEditor(page).press('Control+m');
  await sourceEditor(page).press('Shift+Tab');
  await expect(sourceEditor(page)).not.toBeFocused();
  expect(external).toEqual([]);
  expect(errors).toEqual([]);
});

test('native actions and default visual wrapping work; installed Monaco has no VS Code workbench Alt+Z action', async ({ page }) => {
  await page.goto('/#workspace', { waitUntil: 'domcontentloaded' });
  const source = 'long source text '.repeat(60);
  await fillSource(page, source);
  const state = await nativeState(page);
  expect(state.actions).toEqual(expect.arrayContaining([
    'editor.action.quickCommand', 'editor.action.gotoLine', 'editor.action.commentLine',
    'editor.action.moveLinesDownAction', 'editor.action.copyLinesDownAction',
    'editor.action.addSelectionToNextFindMatch', 'editor.action.indentLines',
    'editor.action.outdentLines', 'editor.action.smartSelect.expand', 'expandLineSelection',
    'actions.find', 'editor.action.startFindReplaceAction',
  ]));
  expect(state.actions).not.toContain('editor.action.toggleWordWrap');
  expect(state.wrap).toBe('on');
  await expect.poll(() => page.locator('.view-lines .view-line').count()).toBeGreaterThan(1);
  const before = await page.locator('.view-lines .view-line').count();
  await page.setViewportSize({ width: 1100, height: 1000 });
  await expect.poll(() => page.locator('.view-lines .view-line').count()).toBeGreaterThan(before);
  await sourceEditor(page).press('Alt+z');
  await sourceEditor(page).press('Alt+z');
  expect((await nativeState(page)).wrap).toBe('on');
  await expectNativeSource(page, source);
});

test('native indentation, comments, line operations, multi-cursors and navigation receive focused keys', async ({ page }) => {
  await page.goto('/#workspace', { waitUntil: 'domcontentloaded' });
  await fillSource(page, 'alpha\nbeta');
  await sourceEditor(page).press('Control+a');
  await sourceEditor(page).press('Tab');
  await expectNativeSource(page, '  alpha\n  beta');
  await sourceEditor(page).press('Shift+Tab');
  await expectNativeSource(page, 'alpha\nbeta');
  await expect(sourceEditor(page)).toBeFocused();
  await sourceEditor(page).press('Control+/');
  await expectNativeSource(page, '% alpha\n% beta');
  await sourceEditor(page).press('Control+/');
  await expectNativeSource(page, 'alpha\nbeta');
  await sourceEditor(page).press('Control+Home');
  await sourceEditor(page).press('Alt+ArrowDown');
  await expectNativeSource(page, 'beta\nalpha');
  const linux = await page.evaluate(() => /Linux/.test(navigator.platform));
  await sourceEditor(page).press(linux ? 'Control+Alt+Shift+ArrowDown' : 'Alt+Shift+ArrowDown');
  await expectNativeSource(page, 'beta\nalpha\nalpha');
  await sourceEditor(page).press('Control+z');
  await expectNativeSource(page, 'beta\nalpha');
  await sourceEditor(page).press('Control+Shift+z');
  await expectNativeSource(page, 'beta\nalpha\nalpha');
  await fillSource(page, 'alpha beta alpha');
  await sourceEditor(page).press('Control+Home');
  await sourceEditor(page).press('Control+d');
  await sourceEditor(page).press('Control+d');
  expect((await nativeState(page)).selections).toHaveLength(2);
  await page.keyboard.insertText('gamma');
  await expectNativeSource(page, 'gamma beta gamma');
  await sourceEditor(page).press('Escape');
  await sourceEditor(page).press('Control+Home');
  await sourceEditor(page).press('Control+Shift+ArrowRight');
  await expect.poll(async () => (await nativeState(page)).selectionTexts[0]?.trim()).toBe('gamma');
  await sourceEditor(page).press('Control+Shift+Enter');
  await expectNativeSource(page, '\ngamma beta gamma');
  await sourceEditor(page).press('Control+m');
  await sourceEditor(page).press('Shift+Tab');
  await expect(sourceEditor(page)).not.toBeFocused();
});

test('native command palette, go to line and find/replace widgets work without app shortcut dispatch', async ({ page }) => {
  await page.goto('/#workspace', { waitUntil: 'domcontentloaded' });
  await fillSource(page, 'alpha\nbeta alpha');
  await sourceEditor(page).press('F1');
  const commands = page.locator('.quick-input-widget');
  await expect(commands).toBeVisible();
  await commands.getByRole('textbox').fill('>Move Line Up');
  await commands.getByRole('option', { name: /^Move Line Up,/ }).click();
  await expectNativeSource(page, 'beta alpha\nalpha');
  await sourceEditor(page).press('Control+g');
  await expect(commands).toBeVisible();
  await commands.getByRole('textbox').fill(':2');
  await commands.getByRole('textbox').press('Enter');
  expect((await nativeState(page)).selections[0].startLineNumber).toBe(2);
  await sourceEditor(page).press('Control+f');
  const find = page.getByRole('textbox', { name: 'Find', exact: true });
  await expect(find).toBeFocused();
  await find.fill('alpha');
  await find.press('Escape');
  await expect(sourceEditor(page)).toBeFocused();
  await sourceEditor(page).press('Control+h');
  const replace = page.getByRole('textbox', { name: 'Replace', exact: true });
  await expect(replace).toBeVisible();
  await find.fill('alpha');
  await replace.fill('gamma');
  await page.getByRole('button', { name: /Replace All/ }).click();
  await expectNativeSource(page, 'beta gamma\ngamma');
  await replace.press('Escape');
  await expect(sourceEditor(page)).toBeFocused();
});

test('Monaco rejects oversized and non-text edits without losing accepted source or undo', async ({ page }) => {
  await page.goto('/#workspace', { waitUntil: 'domcontentloaded' });
  await fillSource(page, 'accepted source');
  await page.keyboard.insertText('x'.repeat(100001));
  await expect(page.locator('.latex-editor-error')).toContainText('last edit was not accepted');
  await expectSource(page, 'accepted source');
  await sourceEditor(page).press('Control+End');
  await page.keyboard.insertText('\u0000');
  await expectSource(page, 'accepted source');
  await fillSource(page, 'x'.repeat(99999));
  await sourceEditor(page).press('Control+End');
  await sourceEditor(page).press('Tab');
  expect((await readSource(page)).length).toBeLessThanOrEqual(100000);
});

test('loading Monaco leaves an immediately editable fallback and preserves its selection at handoff', async ({ page }) => {
  let release;
  const held = new Promise(resolve => { release = resolve; });
  await page.route(/\/assets\/monaco-[^/]+\.js$/, async route => { await held; await route.continue(); });
  await page.goto('/#workspace', { waitUntil: 'domcontentloaded' });
  const fallback = page.locator('.latex-editor-fallback');
  await expect(fallback).toBeEnabled();
  await fallback.fill('fallback edit');
  await fallback.press('Control+End');
  release();
  await editorReady(page);
  await expect(sourceEditor(page)).toBeFocused();
  await page.keyboard.insertText(' after handoff');
  await expectSource(page, 'fallback edit after handoff');
});

test('the first workspace PDF renders before Monaco downloads, with a usable text fallback', async ({ page }) => {
  let release;
  const held = new Promise(resolve => { release = resolve; });
  const monacoRequests = [];
  await page.addInitScript(() => {
    window.firstPdfRenderedAt = null;
    document.addEventListener('load', event => {
      if (event.detail === 'pdf-rendered') window.firstPdfRenderedAt = Date.now();
    }, true);
  });
  await page.route(/\/assets\/monaco-[^/]+\.js$/, async route => {
    monacoRequests.push(Date.now());
    await held;
    await route.continue();
  });
  try {
    await page.goto('/#workspace', { waitUntil: 'domcontentloaded' });
    const fallback = page.locator('.latex-editor-fallback');
    await expect(fallback).toBeEnabled();
    await expect(page.locator('.pdf-viewer:not(.pending) canvas').first()).toBeVisible({ timeout: 30_000 });
    await expect.poll(() => monacoRequests.length).toBe(1);
    const pdfRenderedAt = await page.evaluate(() => window.firstPdfRenderedAt);
    expect(monacoRequests[0]).toBeGreaterThanOrEqual(pdfRenderedAt);
    await expect(fallback).toBeEnabled();
  } finally { release(); }
  await editorReady(page);
});
