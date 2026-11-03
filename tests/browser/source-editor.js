import { expect } from '@playwright/test';

export const sourceEditor = page => page.getByRole('textbox', { name: 'LaTeX source', exact: true });

const editorModifier = page => page.evaluate(() =>
  /Mac/i.test(`${navigator.platform} ${navigator.userAgent}`) ? 'Meta' : 'Control');

export async function editorReady(page) {
  await expect(page.locator('#source-panel')).toBeAttached();
  await expect(page.getByRole('textbox', { name: 'Document title', exact: true })).toBeEnabled({ timeout: 15000 });
  const edit = page.getByRole('button', { name: 'Edit', exact: true });
  if (await edit.isVisible() && await edit.getAttribute('aria-pressed') !== 'true') {
    await edit.click();
    await expect(edit).toHaveAttribute('aria-pressed', 'true', { timeout: 15000 });
  }
  const host = page.locator('.latex-editor-host');
  const fallback = page.locator('.latex-editor-fallback');
  await expect.poll(async () => await host.isVisible() || await fallback.isVisible(), { timeout: 15000 }).toBe(true);
  if (await fallback.isVisible()) {
    await expect(fallback).toBeEnabled();
    await fallback.focus();
  }
  await expect(host).toBeVisible({ timeout: 15000 });
  await expect(sourceEditor(page)).toBeEnabled();
}

export async function fillSource(page, text) {
  await editorReady(page);
  const modifier = await editorModifier(page);
  await sourceEditor(page).press(`${modifier}+a`);
  if (text.length > 10000) {
    await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
    await page.evaluate(text => navigator.clipboard.writeText(text), text);
    await sourceEditor(page).press(`${modifier}+v`);
    await expect(page.locator('.view-lines')).toContainText(text.slice(0, 30));
  } else await page.keyboard.insertText(text);
}

export async function readSource(page) {
  await editorReady(page);
  const modifier = await editorModifier(page);
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
  await sourceEditor(page).press(`${modifier}+a`);
  await sourceEditor(page).press(`${modifier}+c`);
  return page.evaluate(async () => (await navigator.clipboard.readText()).replace(/\r\n/g, '\n'));
}

export async function expectSource(page, text) {
  await expect.poll(() => readSource(page)).toBe(text);
}
