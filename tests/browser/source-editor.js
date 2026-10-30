import { expect } from '@playwright/test';

export const sourceEditor = page => page.getByRole('textbox', { name: 'LaTeX source', exact: true });

export async function editorReady(page) {
  await expect(page.locator('.latex-editor-host')).toBeVisible();
  await expect(sourceEditor(page)).toBeEnabled();
}

export async function fillSource(page, text) {
  await editorReady(page);
  await sourceEditor(page).press('Control+a');
  if (text.length > 10000) {
    await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
    await page.evaluate(text => navigator.clipboard.writeText(text), text);
    await sourceEditor(page).press('Control+v');
    await expect(page.locator('.view-lines')).toContainText(text.slice(0, 30));
  } else await page.keyboard.insertText(text);
}

export async function readSource(page) {
  await editorReady(page);
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
  await sourceEditor(page).press('Control+a');
  await sourceEditor(page).press('Control+c');
  return page.evaluate(async () => (await navigator.clipboard.readText()).replace(/\r\n/g, '\n'));
}

export async function expectSource(page, text) {
  await expect.poll(() => readSource(page)).toBe(text);
}
