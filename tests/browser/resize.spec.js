import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { editorReady } from './source-editor.js';

test.use({ channel: 'chromium' });
const sidebar = page => page.getByRole('separator', { name: 'Document sidebar width' });
const split = page => page.getByRole('separator', { name: 'Source editor width' });
const width = locator => locator.evaluate(element => element.getBoundingClientRect().width);
const value = locator => locator.getAttribute('aria-valuenow').then(Number);

async function drag(page, handle, delta, finish = true) {
  const box = await handle.boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + delta, box.y + 100, { steps: 12 });
  if (finish) await page.mouse.up();
}
async function aligned(page) {
  await expect.poll(async () => Math.abs(await width(page.locator('.monaco-editor').first()) -
    await width(page.locator('.latex-editor-host')))).toBeLessThan(2);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
}
async function evidence(page, name) {
  if (process.env.RESIZE_ARTIFACTS) {
    await page.waitForTimeout(1500);
    await page.screenshot({ path: join(process.env.RESIZE_ARTIFACTS, name + '.png'), fullPage: true });
  }
}

test('actual PDF survives cheap desktop dragging, keyboard limits, reset and persistence', async ({ page }) => {
  await page.setViewportSize({ width: 1920, height: 1080 });
  await page.addInitScript(() => {
    window.resizeAudit = { workers: 0, compiles: 0, drafts: 0 };
    const NativeWorker = window.Worker;
    window.Worker = class extends NativeWorker {
      constructor(url, options) {
        super(url, options);
        this.engine = new URL(url, location.href).pathname === '/compiler/worker.js';
        if (this.engine) window.resizeAudit.workers++;
      }
      postMessage(message, ...rest) {
        if (this.engine && message?.cmd === 'compilelatex') window.resizeAudit.compiles++;
        return super.postMessage(message, ...rest);
      }
    };
    const put = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put = function (...args) {
      window.resizeAudit.drafts++;
      return put.apply(this, args);
    };
  });
  await page.goto('/#workspace');
  await editorReady(page);
  await expect(page.locator('.preview-status')).toContainText('Compiled in your browser', { timeout: 60000 });
  const viewer = page.getByTitle('Compiled PDF', { exact: true });
  await expect(viewer).toBeVisible();
  await expect(page.locator('.pdf-viewer.pending')).toHaveCount(0);
  await expect(page.locator('.save-state')).toContainText('Saved on this device');
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export PDF', exact: true }).click();
  expect((await readFile(await (await download).path())).subarray(0, 5).toString()).toBe('%PDF-');
  const originalUrl = await viewer.getAttribute('data-src');
  await viewer.evaluate(element => { window.originalResizeViewer = element; });
  await evidence(page, 'resize-1920-before');
  const audit = await page.evaluate(() => ({ ...window.resizeAudit }));
  const requests = [];
  page.on('request', request => {
    if (/^https?:/.test(request.url())) requests.push(request.url());
  });
  await drag(page, sidebar(page), 110);
  expect(await value(sidebar(page))).toBe(330);
  await drag(page, split(page), -220);
  await aligned(page);
  await evidence(page, 'resize-1920-after');
  expect(await viewer.evaluate(element => element === window.originalResizeViewer)).toBe(true);
  expect(await viewer.getAttribute('data-src')).toBe(originalUrl);
  expect(await viewer.evaluate(element => getComputedStyle(element).filter)).toBe('none');
  const persisted = await page.evaluate(() => JSON.parse(localStorage.getItem('workspace-layout-v1')));
  await sidebar(page).focus();
  await page.keyboard.press('Home');
  expect(await value(sidebar(page))).toBe(180);
  await page.keyboard.press('End');
  expect(await value(sidebar(page))).toBe(360);
  await page.keyboard.press('Enter');
  expect(await value(sidebar(page))).toBe(220);
  await split(page).focus();
  await page.keyboard.press('Home');
  expect(await value(split(page))).toBe(320);
  await page.keyboard.press('End');
  expect(await width(page.locator('#preview-panel'))).toBeCloseTo(360, 0);
  await page.keyboard.press('Enter');
  const defaultWidth = await value(split(page));
  await page.keyboard.press('ArrowLeft');
  expect(await value(split(page))).toBe(defaultWidth - 16);
  await page.keyboard.press('Shift+ArrowRight');
  expect(await value(split(page))).toBe(defaultWidth + 48);
  await split(page).dblclick();
  expect(await value(split(page))).toBe(defaultWidth);
  await page.waitForTimeout(1200);
  expect(await page.evaluate(() => window.resizeAudit)).toEqual(audit);
  expect(requests).toEqual([]);
  await drag(page, split(page), -140);
  const geometry = await page.locator('.pdf-area').boundingBox();
  await page.getByRole('button', { name: 'Compile', exact: true }).click();
  await expect.poll(() => page.evaluate(() => window.resizeAudit.compiles)).toBeGreaterThan(audit.compiles);
  expect(await page.evaluate(() => window.resizeAudit.workers)).toBe(audit.workers);
  expect(await viewer.getAttribute('data-src')).toBe(originalUrl);
  expect(await page.locator('.pdf-area').boundingBox()).toEqual(geometry);
  await expect(page.locator('.preview-status')).toContainText('Compiled in your browser', { timeout: 60000 });
  await expect(page.locator('.pdf-viewer.pending')).toHaveCount(0);
  expect(await page.locator('.pdf-area').boundingBox()).toEqual(geometry);
  await aligned(page);
  await page.evaluate(preference => localStorage.setItem('workspace-layout-v1', JSON.stringify(preference)), persisted);
  await page.reload();
  await editorReady(page);
  expect(await value(sidebar(page))).toBe(330);
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('workspace-layout-v1')))).toEqual(persisted);
  await aligned(page);
});

test('invalid and unavailable preferences fall back safely; coarse desktop handles stay touch-sized', async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 1100, height: 768 }, hasTouch: true });
  const page = await context.newPage();
  await page.addInitScript(() => {
    localStorage.setItem('workspace-layout-v1', '{not json');
    const set = Storage.prototype.setItem;
    Storage.prototype.setItem = function (key, value) {
      if (key === 'workspace-layout-v1') throw new DOMException('Unavailable', 'SecurityError');
      return set.call(this, key, value);
    };
  });
  try {
    await page.goto(test.info().project.use.baseURL + '/#workspace');
    await editorReady(page);
    expect(await value(sidebar(page))).toBe(208);
    expect(await width(sidebar(page))).toBe(44);
    expect(await width(split(page))).toBe(44);
    await split(page).focus();
    await page.keyboard.press('End');
    expect(await width(page.locator('#preview-panel'))).toBeGreaterThanOrEqual(360);
    await aligned(page);
    await page.keyboard.press('Enter');
    await expect(page.locator('.error-banner')).toHaveCount(0);
  } finally { await context.close(); }
});

test('pointer cancellation, escape, viewport changes and unmount release drag shielding', async ({ page }) => {
  await page.goto('/#workspace');
  await editorReady(page);
  const initial = await value(split(page));
  await drag(page, split(page), -100, false);
  await expect(page.locator('.workspace')).toHaveClass(/pane-dragging/);
  expect(await page.locator('.latex-editor').evaluate(element => getComputedStyle(element).pointerEvents)).toBe('none');
  await split(page).evaluate(element => element.dispatchEvent(new PointerEvent('pointercancel', { pointerId: 1 })));
  await page.mouse.up();
  expect(await value(split(page))).toBe(initial);
  await expect(page.locator('.pane-dragging')).toHaveCount(0);
  await drag(page, split(page), -100, false);
  await page.keyboard.press('Escape');
  await page.mouse.up();
  expect(await value(split(page))).toBe(initial);
  await drag(page, sidebar(page), 80, false);
  await page.setViewportSize({ width: 960, height: 768 });
  await page.mouse.up();
  await expect(page.locator('.pane-dragging')).toHaveCount(0);
  await expect(split(page)).toBeHidden();
  await page.setViewportSize({ width: 1366, height: 768 });
  await drag(page, split(page), 80, false);
  await page.getByRole('button', { name: 'Your projects' }).dispatchEvent('click');
  await page.mouse.up();
  await expect(page.locator('.workspace')).toHaveCount(0);
  await page.getByRole('button', { name: /Untitled paper/ }).first().click();
  await expect(page.locator('.pane-dragging')).toHaveCount(0);
  await aligned(page);
});

test('stale widths, scaled desktop and narrow-screen tabs remain bounded without mobile handles', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('workspace-layout-v1', '{"sidebar":999999,"split":-999}'));
  await page.goto('/#workspace');
  await editorReady(page);
  expect(await value(sidebar(page))).toBe(360);
  expect(await value(split(page))).toBe(320);
  for (const [w, h] of [[1920, 1080], [1366, 768], [960, 768], [390, 844], [844, 390]]) {
    await page.setViewportSize({ width: w, height: h });
    await editorReady(page);
    await aligned(page);
    if (w > 1050) {
      await expect(sidebar(page)).toBeVisible();
      await expect(split(page)).toBeVisible();
      expect(await width(page.locator('#source-panel'))).toBeGreaterThanOrEqual(320);
      expect(await width(page.locator('#preview-panel'))).toBeGreaterThanOrEqual(360);
      await split(page).focus();
      await page.keyboard.press('Enter');
      await evidence(page, `resize-${w}-source`);
    } else {
      await expect(page.getByRole('separator')).toHaveCount(0);
      await expect(page.getByRole('button', { name: 'Edit', exact: true })).toBeVisible();
      await page.getByRole('button', { name: 'Read', exact: true }).click();
      await expect(page.locator('#preview-panel')).toBeVisible();
      await evidence(page, `resize-${w}-preview`);
      await page.getByRole('button', { name: 'Edit', exact: true }).click();
      await page.getByRole('button', { name: 'Toggle documents' }).click();
      await expect(page.locator('#document-sidebar')).toBeVisible();
      await page.getByRole('button', { name: 'Toggle documents' }).click();
    }
  }
});

test('desktop sidebar collapse restores pane preferences, persists and keeps mobile drawer independent', async ({ page }) => {
  await page.setViewportSize({ width: 1366, height: 768 });
  await page.goto('/#workspace');
  await editorReady(page);
  await expect(page.locator('.preview-status')).toContainText('Compiled in your browser', { timeout: 60000 });
  await sidebar(page).focus();
  await page.keyboard.press('ArrowRight');
  const preference = await page.evaluate(() => localStorage.getItem('workspace-layout-v1'));
  const previousWidth = await width(page.locator('#source-panel'));
  const viewer = await page.locator('.pdf-viewer').elementHandle();
  const url = await page.locator('.pdf-viewer').getAttribute('data-src');
  const compile = await page.evaluate(() => latex.timings().compile);
  const toggle = page.getByRole('button', { name: 'Toggle documents', exact: true });
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  await expect(page.locator('#document-sidebar')).toBeHidden();
  await expect(sidebar(page)).toBeHidden();
  expect(await width(page.locator('#source-panel'))).toBeGreaterThan(previousWidth + 100);
  await aligned(page);
  expect(await page.locator('.pdf-viewer').getAttribute('data-src')).toBe(url);
  expect(await viewer.evaluate(element => element.isConnected)).toBe(true);
  expect(await page.evaluate(() => latex.timings().compile)).toEqual(compile);
  expect(await page.evaluate(() => localStorage.getItem('workspace-layout-v1'))).toBe(preference);
  await page.reload();
  await editorReady(page);
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  await toggle.click();
  await expect(sidebar(page)).toBeVisible();
  expect(await width(page.locator('#source-panel'))).toBeCloseTo(previousWidth, 0);
  await toggle.click();
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByRole('button', { name: 'More document actions' })).toHaveCount(0);
  await toggle.click();
  await expect(page.locator('#document-sidebar')).toBeVisible();
  await toggle.click();
  await page.setViewportSize({ width: 1366, height: 768 });
  await expect(page.locator('#document-sidebar')).toBeHidden();
  await aligned(page);
});

test('desktop document overflow supports keyboard, Escape, outside dismissal and document creation', async ({ page }) => {
  await page.goto('/#workspace');
  await editorReady(page);
  await page.getByRole('button', { name: 'Toggle documents', exact: true }).click();
  const more = page.getByRole('button', { name: 'More document actions' });
  const menu = page.getByRole('group', { name: 'Document actions', exact: true });
  await more.focus();
  await page.keyboard.press('Enter');
  await expect(menu).toBeVisible();
  await page.keyboard.press('Tab');
  await expect(menu.getByRole('button', { name: 'New document', exact: true })).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(menu).toBeHidden();
  await expect(more).toBeFocused();
  await more.click();
  await page.locator('.document-title input').click();
  await expect(menu).toBeHidden();
  await more.click();
  await menu.getByRole('button', { name: 'New document', exact: true }).click();
  await expect(menu).toBeHidden();
  await expect(page.locator('#document-sidebar')).toBeHidden();
  await expect(page.locator('.document-row')).toHaveCount(2);
  await expect(page.getByRole('textbox', { name: 'Document title', exact: true })).toHaveValue('Untitled paper');
});
