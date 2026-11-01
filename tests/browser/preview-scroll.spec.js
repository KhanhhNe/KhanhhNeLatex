import { test, expect, webkit, devices } from '@playwright/test';
import { fillSource } from './source-editor.js';

const pagesSource = (label, count = 12) => String.raw`\documentclass{article}\begin{document}` +
  Array.from({ length: count }, (_, index) => `${label} page ${index + 1}${index < count - 1 ? String.raw`\newpage` : ''}`)
    .join('\n') + String.raw`\end{document}`;

async function multiPage(page, label = 'Scroll') {
  await page.goto('/#workspace');
  await fillSource(page, pagesSource(label));
  await page.getByRole('button', { name: 'Compile', exact: true }).click();
  const read = page.getByRole('button', { name: 'Read', exact: true });
  if (await read.isVisible()) await read.click();
  await expect(page.locator('.pdf-viewer:not(.pending) .pdf-page')).toHaveCount(12);
  await expect(page.locator('.pdf-viewer.pending')).toHaveCount(0);
  await expect(page.locator('.pdf-viewer canvas').first()).toBeVisible();
  await page.waitForTimeout(300);
}

const nativeScrollContract = page => page.locator('.pdf-viewport').evaluate(view => {
  const style = getComputedStyle(view);
  const plain = new WheelEvent('wheel', { deltaY: 40, cancelable: true, bubbles: true });
  view.dispatchEvent(plain);
  const pinch = new WheelEvent('wheel', { deltaY: -4, ctrlKey: true, cancelable: true, bubbles: true });
  view.dispatchEvent(pinch);
  const single = new Event('touchmove', { cancelable: true, bubbles: true });
  Object.defineProperty(single, 'touches', { value: [{ clientX: 10, clientY: 10 }] });
  view.dispatchEvent(single);
  return { overflowY: style.overflowY, touchAction: style.touchAction, snap: style.scrollSnapType,
    behavior: style.scrollBehavior,
    overscroll: CSS.supports('overscroll-behavior', 'contain') ? style.getPropertyValue('overscroll-behavior-y') : 'contain',
    plainPrevented: plain.defaultPrevented, pinchPrevented: pinch.defaultPrevented,
    touchPrevented: single.defaultPrevented };
});

function expectNativeScroll(contract) {
  expect(contract.overflowY).toBe('auto');
  expect(contract.touchAction).toBe('pan-x pan-y');
  expect(['none', '']).toContain(contract.snap);
  expect(contract.behavior).toBe('auto');
  expect(contract.overscroll).toBe('contain');
  expect(contract.plainPrevented).toBe(false);
  expect(contract.touchPrevented).toBe(false);
  expect(contract.pinchPrevented).toBe(true);
}

test('plain wheel scrolling stays native and a modifier during the inertial tail never zooms', async ({ page }) => {
  await multiPage(page);
  expectNativeScroll(await nativeScrollContract(page));
  const viewport = page.locator('.pdf-viewport');
  const zoom = await page.locator('.pdf-viewer output').textContent();
  const box = await viewport.boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  const top = await viewport.evaluate(view => view.scrollTop);
  await page.mouse.wheel(0, 600);
  await expect.poll(() => viewport.evaluate(view => view.scrollTop)).toBeGreaterThan(top + 300);
  const tail = await viewport.evaluate(async view => {
    const box = view.getBoundingClientRect(), x = box.left + box.width / 2, y = box.top + box.height / 2;
    const fire = init => {
      const event = new WheelEvent('wheel', { clientX: x, clientY: y, cancelable: true, bubbles: true, ...init });
      view.dispatchEvent(event);
      return event.defaultPrevented;
    };
    // macOS-style momentum: decaying plain deltas every frame, then Ctrl/Cmd pressed mid-tail.
    for (let delta = 30; delta > 4; delta *= .85) { fire({ deltaY: delta }); await new Promise(requestAnimationFrame); }
    const before = view.scrollTop, prevented = [];
    for (let index = 0; index < 8; index++) {
      prevented.push(fire({ deltaY: 3, ctrlKey: true }));
      prevented.push(fire({ deltaY: 3, metaKey: true }));
      await new Promise(requestAnimationFrame);
    }
    return { zoom: document.querySelector('.pdf-viewer output').textContent, prevented, before, after: view.scrollTop };
  });
  expect(tail.zoom).toBe(zoom);
  expect(tail.prevented.every(Boolean)).toBe(true);
  expect(tail.after).toBeGreaterThan(tail.before);
  await page.waitForTimeout(200);
  // A fresh pinch after the tail has ended zooms normally.
  await viewport.evaluate(view => view.dispatchEvent(new WheelEvent('wheel', { deltaY: -20, ctrlKey: true, cancelable: true })));
  await expect(page.locator('.pdf-viewer output')).not.toHaveText(zoom);
});

test('lazy re-renders and recompilation swaps never move or interrupt an active scroll', async ({ page }) => {
  await multiPage(page);
  const viewport = page.locator('.pdf-viewer:not(.pending) .pdf-viewport');
  await viewport.evaluate(view => { view.scrollTop = view.scrollHeight / 3; });
  const anchored = await viewport.evaluate(async view => {
    const top = view.scrollTop, writes = [];
    let max = 0;
    const observe = () => writes.push(view.scrollTop);
    view.addEventListener('scroll', observe);
    await new Promise(resolve => setTimeout(resolve, 900));
    for (const value of writes) max = Math.max(max, Math.abs(value - top));
    view.removeEventListener('scroll', observe);
    return { top, now: view.scrollTop, max, canvases: view.querySelectorAll('canvas').length };
  });
  expect(anchored.now).toBe(anchored.top);
  expect(anchored.max).toBe(0);
  expect(anchored.canvases).toBeGreaterThan(0);

  const before = await page.locator('.pdf-viewer:not(.pending)').getAttribute('data-src');
  await fillSource(page, pagesSource('Replacement'));
  await page.getByRole('button', { name: 'Compile', exact: true }).click();
  const read = page.getByRole('button', { name: 'Read', exact: true });
  if (await read.isVisible()) await read.click();
  const scrolling = await page.evaluate(async before => {
    const shown = () => document.querySelector('.pdf-viewer:not(.pending)');
    const view = shown().querySelector('.pdf-viewport');
    let swappedWhileScrolling = false, pendingSeen = false;
    const started = performance.now();
    // Keep a continuous scroll alive (like a long momentum tail) until a replacement has loaded behind it.
    while (performance.now() - started < 20000) {
      view.scrollTop += 3;
      await new Promise(requestAnimationFrame);
      if (shown()?.dataset.src !== before) swappedWhileScrolling = true;
      pendingSeen ||= Boolean(document.querySelector('.pdf-viewer.pending canvas'));
      if (pendingSeen && performance.now() - started > 1500) break;
    }
    for (let index = 0; index < 20; index++) {
      view.scrollTop += 3;
      await new Promise(requestAnimationFrame);
      if (shown()?.dataset.src !== before) swappedWhileScrolling = true;
    }
    return { swappedWhileScrolling, pendingSeen, final: view.scrollTop };
  }, before);
  expect(scrolling.pendingSeen).toBe(true);
  expect(scrolling.swappedWhileScrolling).toBe(false);
  await expect(page.locator('.pdf-viewer:not(.pending)')).not.toHaveAttribute('data-src', before);
  await expect(page.locator('.pdf-viewer.pending')).toHaveCount(0);
  const adopted = await page.locator('.pdf-viewer .pdf-viewport').evaluate(view => view.scrollTop);
  expect(Math.abs(adopted - scrolling.final)).toBeLessThanOrEqual(2);
});

test('iPhone touch pans are browser-native (no script scrolling) and pinch still zooms only the PDF', async ({ browser, baseURL }) => {
  const { defaultBrowserType, ...iPhone } = devices['iPhone 13'];
  const context = await browser.newContext({ ...iPhone, baseURL });
  const page = await context.newPage();
  try {
    await multiPage(page);
    expectNativeScroll(await nativeScrollContract(page));
    const client = await context.newCDPSession(page);
    const viewport = page.locator('.pdf-viewport');
    const box = await viewport.boundingBox();
    await viewport.evaluate(view => {
      // Count any script-driven scrolling; a native pan (which carries OS momentum on devices) makes none.
      window.scriptScrolls = 0;
      for (const name of ['scrollTop', 'scrollLeft']) {
        const native = Object.getOwnPropertyDescriptor(Element.prototype, name);
        Object.defineProperty(view, name, { configurable: true, get() { return native.get.call(this); },
          set(value) { window.scriptScrolls++; native.set.call(this, value); } });
      }
      for (const name of ['scrollBy', 'scrollTo', 'scroll']) {
        const native = view[name].bind(view);
        view[name] = (...args) => { window.scriptScrolls++; native(...args); };
      }
    });
    const top = await viewport.evaluate(view => view.scrollTop);
    const x = box.x + box.width / 2, y = box.y + box.height * .8;
    await client.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y, id: 1 }] });
    for (let step = 1; step <= 8; step++) {
      await page.waitForTimeout(16);
      await client.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x, y: y - step * 25, id: 1 }] });
    }
    await client.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await page.waitForTimeout(400);
    expect(await viewport.evaluate(view => view.scrollTop)).toBeGreaterThan(top + 100);
    expect(await page.evaluate(() => window.scriptScrolls)).toBe(0);

    const zoom = await page.locator('.pdf-viewer output').textContent();
    const cx = box.x + box.width / 2, cy = box.y + box.height / 2;
    const touches = distance => [{ x: cx - distance, y: cy, id: 2 }, { x: cx + distance, y: cy, id: 3 }];
    const pageScale = await page.evaluate(() => visualViewport.scale);
    await client.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: touches(30) });
    for (let distance = 34; distance <= 60; distance += 2)
      await client.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: touches(distance) });
    await client.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await expect(page.locator('.pdf-viewer output')).not.toHaveText(zoom);
    expect(await page.evaluate(() => visualViewport.scale)).toBe(pageScale);
  } finally { await context.close(); }
});

test('WebKit keeps wheel and touch scrolling native for Safari momentum', async ({ baseURL }) => {
  const browser = await webkit.launch();
  const { defaultBrowserType, ...iPhone } = devices['iPhone 13'];
  const mobile = process.platform !== 'win32';
  const context = await browser.newContext(mobile ? { ...iPhone, baseURL } : { baseURL, viewport: { width: 1440, height: 1000 } });
  const page = await context.newPage();
  try {
    await multiPage(page);
    expectNativeScroll(await nativeScrollContract(page));
    const viewport = page.locator('.pdf-viewport');
    const top = await viewport.evaluate(view => view.scrollTop);
    if (mobile) {
      const box = await viewport.boundingBox();
      await page.touchscreen.tap(box.x + box.width / 2, box.y + box.height / 2);
      await viewport.evaluate(view => { view.scrollTop += 400; });
    } else {
      const box = await viewport.boundingBox();
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      await page.mouse.wheel(0, 400);
    }
    await expect.poll(() => viewport.evaluate(view => view.scrollTop)).toBeGreaterThan(top + 200);
    const zoom = await page.locator('.pdf-viewer output').textContent();
    expect(zoom).toMatch(/%$/);
  } finally { await context.close(); await browser.close(); }
});
