import { test, expect } from '@playwright/test';
import { editorReady, sourceEditor, fillSource, expectSource, readSource } from './source-editor.js';

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
  await sourceEditor(page).press('Shift+Tab');
  await expect(sourceEditor(page)).not.toBeFocused();
  expect(external).toEqual([]);
  expect(errors).toEqual([]);
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
