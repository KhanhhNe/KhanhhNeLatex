import { test, expect } from '@playwright/test';
import { editorReady, expectSource, sourceEditor } from './source-editor.js';

for (const [width, height] of [[1920, 1080], [1366, 768], [390, 844], [844, 390]]) {
  test(`source typography matches title through fallback, handoff and zoom at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height });
    let release;
    const held = new Promise(resolve => { release = resolve; });
    await page.route(/\/assets\/monaco-[^/]+\.js$/, async route => { await held; await route.continue(); });
    try {
      await page.goto('/#workspace', { waitUntil: 'domcontentloaded' });
      const fallback = page.locator('.latex-editor-fallback');
      await expect(fallback).toBeEnabled();
      const titleSize = () => page.locator('.document-title input').evaluate(element => parseFloat(getComputedStyle(element).fontSize));
      const metrics = locator => locator.evaluate(element => {
        const style = getComputedStyle(element);
        return { size: parseFloat(style.fontSize), line: parseFloat(style.lineHeight) };
      });
      const originalSize = width > 1050 ? 14 : 16;
      expect(await titleSize()).toBe(originalSize);
      expect(await metrics(fallback)).toEqual({ size: originalSize, line: originalSize * 1.5 });
      await fallback.fill('fallback stays the same size');
      await fallback.press('Control+End');
      release();
      await editorReady(page);
      await expect(sourceEditor(page)).toBeFocused();
      await page.keyboard.insertText(' after handoff');
      await expectSource(page, 'fallback stays the same size after handoff');
      for (const rootSize of [16, 20, 16]) {
        await page.evaluate(size => { document.documentElement.style.fontSize = `${size}px`; }, rootSize);
        const expected = originalSize * rootSize / 16;
        await expect.poll(async () => (await metrics(page.locator('.view-lines'))).size).toBe(expected);
        expect(await titleSize()).toBe(expected);
        expect((await metrics(page.locator('.view-lines'))).line).toBe(Math.round(expected * 1.5));
        expect((await metrics(page.locator('.line-numbers').first())).size).toBe(expected);
        expect((await metrics(page.locator('.monaco-editor').first())).size).toBe(expected);
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      }
      if (width > 1050) {
        await page.getByRole('separator', { name: 'Source editor width' }).focus();
        await page.keyboard.press('Home');
        await expect.poll(async () => {
          const editor = await page.locator('.monaco-editor').first().boundingBox();
          const host = await page.locator('.latex-editor-host').boundingBox();
          return Math.abs(editor.width - host.width);
        }).toBeLessThan(2);
        expect((await metrics(page.locator('.view-lines'))).size).toBe(await titleSize());
      } else {
        expect((await metrics(sourceEditor(page))).size).toBeGreaterThanOrEqual(16);
      }
    } finally { release(); }
  });
}
