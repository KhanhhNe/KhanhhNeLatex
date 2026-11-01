import { test, expect, webkit } from '@playwright/test';
import { editorReady, fillSource } from './source-editor.js';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

async function preview(page) {
  await page.addInitScript(() => {
    const NativeWorker = Worker;
    window.previewWorkers = [];
    window.compilerStarts = 0;
    window.Worker = class extends NativeWorker {
      constructor(url, options) {
        super(url, options);
        if (String(url).includes('/compiler/worker.js')) window.compilerStarts++;
        if (String(url).includes('pdf.worker')) {
          const record = { terminated: false };
          window.previewWorkers.push(record);
          const terminate = this.terminate.bind(this);
          this.terminate = () => { record.terminated = true; terminate(); };
        }
      }
    };
  });
  await page.goto('/#workspace');
  const tab = page.getByRole('button', { name: 'PDF preview', exact: true });
  if (await tab.isVisible()) await tab.click();
  await expect(page.locator('.pdf-viewer canvas').first()).toBeVisible();
  await expect(page.locator('.pdf-viewer.pending')).toHaveCount(0);
  await page.waitForTimeout(300);
}

test('trackpad pinch scales existing PDF pixels without rendering, loading or compiling during the gesture', async ({ page }) => {
  await preview(page);
  const requests = [];
  page.on('request', request => requests.push(request.url()));
  const client = await page.context().newCDPSession(page);
  await client.send('Emulation.setCPUThrottlingRate', { rate: 4 });
  const evidence = await page.evaluate(async () => {
    const viewport = document.querySelector('.pdf-viewport');
    const pages = document.querySelector('.pdf-pages');
    const canvas = pages.querySelector('canvas');
    window.pinchCanvas = canvas;
    const workerCount = window.previewWorkers.length, compilerCount = window.compilerStarts;
    const source = document.querySelector('.pdf-viewer').dataset.src;
    const durations = [], longTasks = [];
    const observer = new PerformanceObserver(list => longTasks.push(...list.getEntries().map(entry => entry.duration)));
    observer.observe({ type: 'longtask' });
    const box = viewport.getBoundingClientRect();
    let previous = performance.now();
    for (let index = 0; index < 45; index++) {
      viewport.dispatchEvent(new WheelEvent('wheel', { ctrlKey: true, deltaY: -2,
        clientX: box.left + box.width / 2, clientY: box.top + box.height / 2, cancelable: true }));
      await new Promise(requestAnimationFrame);
      const now = performance.now();
      durations.push(now - previous);
      previous = now;
      if (pages.querySelector('canvas') !== canvas) throw new Error('Canvas replaced during pinch');
    }
    observer.disconnect();
    return { source, sameCanvas: canvas.isConnected, compilerCount, compilerAfter: window.compilerStarts,
      workerCount, workerAfter: window.previewWorkers.length, zoom: document.querySelector('output').textContent,
      transform: pages.style.transform, frames: durations, longTasks };
  });
  expect(evidence.sameCanvas).toBe(true);
  expect(evidence.compilerAfter).toBe(evidence.compilerCount);
  expect(evidence.workerAfter).toBe(evidence.workerCount);
  expect(evidence.transform).not.toBe('scale(1)');
  expect(requests).toEqual([]);
  expect(await page.locator('.pdf-viewer').getAttribute('data-src')).toBe(evidence.source);
  await page.waitForTimeout(500);
  await expect.poll(() => page.evaluate(() =>
    document.querySelector('.pdf-viewer canvas') !== window.pinchCanvas)).toBe(true);
  expect(await page.locator('.pdf-viewer canvas').count()).toBeLessThanOrEqual(3);
  await page.getByRole('button', { name: 'Zoom in', exact: true }).click();
  const viewport = page.getByRole('region', { name: /^PDF pages/ });
  await viewport.focus();
  await viewport.press('Control+-');
  await viewport.press('Control+0');
  await expect(page.locator('.pdf-viewer output')).not.toHaveText(evidence.zoom);
  await expect(page.getByRole('link', { name: 'Open PDF', exact: true })).toHaveAttribute('href', evidence.source);
  if (process.env.ZOOM_ARTIFACTS) {
    const sorted = evidence.frames.toSorted((a, b) => a - b);
    await writeFile(join(process.env.ZOOM_ARTIFACTS, 'smooth-pinch.json'), JSON.stringify({
      ...evidence, p95FrameMs: sorted[Math.floor(sorted.length * .95)],
      note: '4x CPU throttle; synthetic Ctrl-wheel delivered per animation frame. Measures app preview only, not physical-device latency.',
    }, null, 2));
    await page.screenshot({ path: join(process.env.ZOOM_ARTIFACTS, 'smooth-preview.png') });
  }
});

test('real two-finger pinch zooms only the PDF, preserves its anchor and supports one-finger pan', async ({ browser, baseURL }) => {
  const context = await browser.newContext({ baseURL, viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const page = await context.newPage();
  await preview(page);
  const client = await context.newCDPSession(page);
  const viewport = page.locator('.pdf-viewport');
  const box = await viewport.boundingBox();
  const x = box.x + box.width / 2, y = box.y + box.height / 2;
  const state = () => page.evaluate(() => {
    const view = document.querySelector('.pdf-viewport'), sheet = document.querySelector('.pdf-sheet');
    const scale = Number(document.querySelector('.pdf-pages').style.transform.match(/[\d.]+/)[0]);
    return { scale, anchorX: (view.scrollLeft + view.clientWidth / 2 - sheet.offsetLeft) / scale,
      anchorY: (view.scrollTop + view.clientHeight / 2 - sheet.offsetTop) / scale,
      pageScale: visualViewport.scale, top: view.scrollTop, workers: window.compilerStarts };
  });
  const before = await state();
  const touches = distance => [{ x: x - distance, y, id: 1 }, { x: x + distance, y, id: 2 }];
  await client.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: touches(30) });
  for (let distance = 32; distance <= 60; distance += 2) {
    await client.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: touches(distance) });
  }
  await client.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  const after = await state();
  expect(after.scale).toBeCloseTo(before.scale * 2, 1);
  expect(after.pageScale).toBe(before.pageScale);
  expect(Math.abs(after.anchorX - before.anchorX)).toBeLessThan(2);
  expect(Math.abs(after.anchorY - before.anchorY)).toBeLessThan(2);
  expect(after.workers).toBe(before.workers);
  await client.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y, id: 3 }] });
  await client.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x, y: y - 60, id: 3 }] });
  await client.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  expect((await state()).top).toBeGreaterThan(after.top + 40);
  await context.close();
});

test('multi-page scrolling and high zoom bound canvas memory; switching terminates the PDF worker', async ({ page }) => {
  await preview(page);
  await editorReady(page);
  await fillSource(page, String.raw`\documentclass{article}\begin{document}` +
    Array.from({ length: 12 }, (_, index) => `Page ${index + 1}${index < 11 ? String.raw`\newpage` : ''}`).join('\n') +
    String.raw`\end{document}`);
  await page.getByRole('button', { name: 'Compile', exact: true }).click();
  await expect(page.locator('.pdf-page')).toHaveCount(12);
  await expect(page.locator('.pdf-viewer.pending')).toHaveCount(0);
  for (let index = 0; index < 15; index++) await page.getByRole('button', { name: 'Zoom in', exact: true }).click();
  await expect(page.locator('.pdf-viewer output')).toHaveText('400%');
  await page.locator('.pdf-viewport').evaluate(view => { view.scrollTop = view.scrollHeight; });
  await expect(page.locator('.pdf-page').last().locator('canvas')).toBeVisible();
  const pixels = await page.locator('.pdf-viewer canvas').evaluateAll(canvases =>
    canvases.map(canvas => canvas.width * canvas.height));
  expect(pixels.length).toBeLessThanOrEqual(3);
  for (const count of pixels) expect(count).toBeLessThanOrEqual(2_000_000);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  expect(await page.locator('.pdf-viewer').evaluate(node => getComputedStyle(node).transitionDuration)).toBe('0s');
  await page.getByRole('button', { name: 'New document', exact: true }).click();
  await expect.poll(() => page.evaluate(() => window.previewWorkers.slice(0, -1).every(worker => worker.terminated))).toBe(true);
  await expect(page.locator('.pdf-viewer output')).not.toHaveText('400%');
});

test('hidden mobile preview can finish a replacement without losing zoom or timing out', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await preview(page);
  const initialUrl = await page.locator('.pdf-viewer').getAttribute('data-src');
  const initialZoom = await page.locator('.pdf-viewer output').textContent();
  await page.getByRole('button', { name: 'Zoom in', exact: true }).click();
  await expect(page.locator('.pdf-viewer output')).not.toHaveText(initialZoom);
  const zoom = await page.locator('.pdf-viewer output').textContent();
  await page.getByRole('checkbox', { name: 'Live preview', exact: true }).check();
  await page.getByRole('button', { name: 'Source', exact: true }).click();
  await fillSource(page, String.raw`\documentclass{article}\begin{document}Replacement PDF.\end{document}`);
  // Live compilation is intentionally allowed to complete while Source stays active.
  await expect(page.locator('.pdf-viewer[title="Compiled PDF"]')).not.toHaveAttribute('data-src', initialUrl);
  await expect(page.locator('.pdf-viewer.pending')).toHaveCount(0);
  await expect(page.locator('.preview-status')).toContainText('Compiled in your browser');
  await page.getByRole('button', { name: 'PDF preview', exact: true }).click();
  await expect(page.locator('.pdf-viewer output')).toHaveText(zoom);
  await expect(page.locator('.pdf-viewer canvas')).toBeVisible();
  await expect(page.locator('.pdf-render-error')).toHaveCount(0);
});

test('a stalled PDF worker times out explicitly and Retry preview does not recompile', async ({ page }) => {
  await page.addInitScript(() => {
    const NativeWorker = Worker;
    window.stallPdf = true;
    window.Worker = class extends NativeWorker {
      constructor(url, options) {
        super(url, options);
        this.pdfPreview = String(url).includes('pdf.worker');
      }
      postMessage(...args) {
        if (this.pdfPreview && window.stallPdf) return;
        super.postMessage(...args);
      }
    };
  });
  await page.goto('/#workspace');
  await expect(page.getByRole('button', { name: 'Retry preview', exact: true })).toBeVisible({ timeout: 25000 });
  await expect(page.locator('.pdf-render-error')).toContainText('timed out');
  await expect(page.getByRole('button', { name: 'Export PDF', exact: true })).toBeEnabled();
  const source = await page.locator('.pdf-viewer').getAttribute('data-src');
  await page.evaluate(() => { window.stallPdf = false; });
  await page.getByRole('button', { name: 'Retry preview', exact: true }).click();
  await expect(page.locator('.pdf-viewer canvas')).toBeVisible();
  await expect(page.locator('.pdf-render-error')).toHaveCount(0);
  expect(await page.locator('.pdf-viewer').getAttribute('data-src')).toBe(source);
});

test('WebKit gesture events scale the existing raster and preserve browser zoom', async ({ baseURL }) => {
  const browser = await webkit.launch();
  const context = await browser.newContext({ baseURL, viewport: { width: 1440, height: 1000 } });
  const page = await context.newPage();
  try {
    await preview(page);
    const result = await page.evaluate(async () => {
      const viewport = document.querySelector('.pdf-viewport'), canvas = viewport.querySelector('canvas');
      const original = Number(document.querySelector('.pdf-pages').style.transform.match(/[\d.]+/)[0]);
      const browserScale = visualViewport.scale, box = viewport.getBoundingClientRect();
      const fire = (type, scale) => viewport.dispatchEvent(Object.assign(new Event(type, { cancelable: true }),
        { scale, clientX: box.left + box.width / 2, clientY: box.top + box.height / 2 }));
      fire('gesturestart', 1);
      for (let scale = 1.05; scale < 1.5; scale += .05) {
        fire('gesturechange', scale);
        await new Promise(requestAnimationFrame);
        if (viewport.querySelector('canvas') !== canvas) throw new Error('WebKit rerendered during gesture');
      }
      fire('gestureend', 1.5);
      return { original, browserScale, afterBrowser: visualViewport.scale,
        after: Number(document.querySelector('.pdf-pages').style.transform.match(/[\d.]+/)[0]) };
    });
    expect(result.after).toBeGreaterThan(result.original * 1.4);
    expect(result.afterBrowser).toBe(result.browserScale);
  } finally { await context.close(); await browser.close(); }
});
