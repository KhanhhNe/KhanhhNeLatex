import { test, expect, devices, chromium, webkit } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { editorReady, sourceEditor } from './source-editor.js';

for (const browserType of [chromium, webkit]) {
  for (const [orientation, width, height] of [['portrait', 390, 844], ['landscape', 844, 390]]) {
    test(`${browserType.name()} ${orientation}: reading defers Monaco and keeps exports and PDF reachable`, async ({ baseURL }) => {
      const browser = await browserType.launch({ channel: browserType === chromium ? 'chromium' : undefined });
      const context = await browser.newContext({ ...devices['iPhone 13 Pro'], baseURL, viewport: { width, height } });
      const page = await context.newPage();
      const requests = [], errors = [];
      page.on('request', request => requests.push(request.url()));
      page.on('pageerror', error => errors.push(error.message));
      try {
        await page.goto('/');
        await page.getByRole('list', { name: 'Projects' }).getByRole('button').first().click();
        await expect(page.getByRole('button', { name: 'Read', exact: true })).toHaveAttribute('aria-pressed', 'true');
        await expect(page.locator('.latex-editor')).toHaveCount(0);
        await expect(page.locator('.pdf-viewer canvas').first()).toBeVisible({ timeout: 60000 });
        expect(requests.filter(url => /monaco-|editor\.worker/.test(url))).toEqual([]);
        await expect(page.locator('.pdf-viewer')).toHaveCount(1);
        await expect(page.getByRole('button', { name: 'Save to account' })).toBeHidden();
        await expect(page.getByRole('textbox', { name: 'Document title' })).toHaveAttribute('readonly', '');
        const viewport = await page.locator('.pdf-viewport').boundingBox();
        expect(viewport.height).toBeGreaterThan(height === 844 ? 400 : 100);
        expect(viewport.y + viewport.height).toBeLessThanOrEqual(height);
        expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(width);
        for (const name of ['Export .tex', 'Export PDF']) {
          const button = page.getByRole('button', { name, exact: true });
          await expect(button).toBeInViewport();
          const box = await button.boundingBox();
          expect(box.height).toBeGreaterThanOrEqual(44);
          const waiting = page.waitForEvent('download');
          await button.click();
          const bytes = await readFile(await (await waiting).path());
          expect(bytes.subarray(0, 5).toString()).toBe(name === 'Export PDF' ? '%PDF-' : '\\docu');
        }
        await expect(page.getByRole('link', { name: 'Open PDF', exact: true })).toBeInViewport();
        if (process.env.MOBILE_ARTIFACTS) await page.screenshot({
          path: join(process.env.MOBILE_ARTIFACTS, `after-${browserType.name()}-${orientation}.png`),
        });
        const pdf = await page.locator('.pdf-viewer').elementHandle();
        await page.getByRole('button', { name: 'Edit', exact: true }).click();
        await editorReady(page);
        await expect(page.getByRole('button', { name: 'Compile', exact: true })).toHaveText('Compile & read');
        await expect(page.getByRole('button', { name: 'Save to account' })).toBeVisible();
        await page.getByRole('textbox', { name: 'Document title' }).fill('Mobile reading review');
        await expect(page.getByRole('button', { name: 'Edit', exact: true })).toHaveAttribute('aria-pressed', 'true');
        await expect(page).toHaveURL(/\/documents\/mobile-reading-review\/[A-Za-z0-9_-]{8}$/);
        const editor = await page.locator('.monaco-editor').elementHandle();
        await page.getByRole('button', { name: 'Read', exact: true }).click();
        expect(await pdf.evaluate(element => element.isConnected)).toBe(true);
        await page.getByRole('button', { name: 'Edit', exact: true }).click();
        expect(await editor.evaluate(element => element === document.querySelector('.monaco-editor'))).toBe(true);
        // iOS WebKit's synthetic textarea key events do not emulate native editing.
        // Exercise real editing/undo in Chromium; both engines cover mode and viewer lifecycles.
        if (browserType === chromium) {
          await sourceEditor(page).press('Meta+ArrowDown');
          await page.keyboard.insertText('% light edit');
          await page.getByRole('button', { name: 'Read', exact: true }).click();
          expect(await pdf.evaluate(element => element.isConnected)).toBe(true);
          await expect(page.locator('.pdf-viewer')).toHaveCount(1);
          await expect(page.locator('.preview-status')).toContainText('out of date');
          await page.getByRole('button', { name: 'Edit', exact: true }).click();
          await sourceEditor(page).press('Meta+z');
          await expect(page.locator('.view-lines')).not.toContainText('light edit');
          await page.getByRole('button', { name: 'Compile', exact: true }).click();
          await expect(page.getByRole('button', { name: 'Read', exact: true })).toHaveAttribute('aria-pressed', 'true', { timeout: 60000 });
          await expect(page.locator('.pdf-viewer.pending')).toHaveCount(0);
          await expect(page.locator('.pdf-viewer')).toHaveCount(1);
          await page.getByRole('button', { name: 'Edit', exact: true }).click();
          await sourceEditor(page).press('Meta+a');
          await page.keyboard.insertText(String.raw`\documentclass{article}\begin{document}\badmobilecommand\end{document}`);
          await expect(page.locator('.view-lines')).toContainText('badmobilecommand');
          await page.getByRole('button', { name: 'Compile', exact: true }).click();
          await page.getByRole('button', { name: 'Read', exact: true }).click();
          await expect(page.locator('.compile-log')).toContainText('Undefined control sequence', { timeout: 60000 });
          await expect(page.locator('.pdf-viewer')).toHaveCount(1);
          await expect(page.locator('.pdf-viewer canvas').first()).toBeVisible();
          await expect(page.locator('.preview-status')).toContainText('out of date');
        }
        await page.getByRole('button', { name: 'Your projects', exact: true }).click();
        await page.getByRole('button', { name: 'New document', exact: true }).click();
        await expect(page.getByRole('button', { name: 'Read', exact: true })).toHaveAttribute('aria-pressed', 'true');
        await expect(page.locator('.latex-editor')).toHaveCount(0);
        await page.setViewportSize({ width: 1440, height: 900 });
        await editorReady(page);
        const desktopEditor = await page.locator('.monaco-editor').elementHandle();
        await page.evaluate(() => latex.show('source'));
        await expect(page.getByRole('button', { name: 'Read', exact: true, includeHidden: true })).toHaveAttribute('aria-pressed', 'false');
        await page.setViewportSize({ width, height });
        await expect(page.getByRole('button', { name: 'Read', exact: true })).toHaveAttribute('aria-pressed', 'true');
        expect(await desktopEditor.evaluate(element => element === document.querySelector('.monaco-editor'))).toBe(true);
        await page.evaluate(() => latex.show('source'));
        await expect(page.getByRole('button', { name: 'Edit', exact: true })).toHaveAttribute('aria-pressed', 'true');
        await expect(page.locator('.latex-editor-host')).toBeVisible();
        expect(errors).toEqual([]);
      } finally {
        await context.close();
        await browser.close();
      }
    });
  }
}
