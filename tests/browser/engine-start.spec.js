import { test, expect } from '@playwright/test';

async function observeWorkers(page) {
  await page.addInitScript(() => {
    window.engineStarts = [];
    const NativeWorker = window.Worker;
    window.Worker = class extends NativeWorker {
      constructor(url, options) {
        super(url, options);
        if (!String(url).includes('/compiler/')) return;
        const record = { url: String(url), start: performance.now(), terminated: 0 };
        window.engineStarts.push(record);
        const terminate = this.terminate.bind(this);
        this.terminate = () => { record.terminated++; terminate(); };
        this.addEventListener('message', ({ data }) => {
          if (!data.cmd && data.result === 'ok') record.ready = performance.now();
          if (data.cmd === 'compile' && data.result === 'ok') record.magic = new TextDecoder().decode(new Uint8Array(data.pdf).slice(0, 5));
        });
      }
    };
  });
}

test('engine becomes ready while the main bundle is held, then the app adopts it once', async ({ page }) => {
  await observeWorkers(page);
  const engineRequests = [];
  page.context().on('request', request => {
    if (/\/compiler\/(?:swiftlatexpdftex\.wasm|formats\/pdftex-)/.test(request.url())) engineRequests.push(request.url());
  });
  let release;
  const hold = new Promise(resolve => { release = resolve; });
  await page.route(/\/assets\/index-[^/]+\.js$/, async route => {
    await hold;
    await route.continue();
  });
  await page.goto('/#workspace', { waitUntil: 'commit' });
  try {
    await page.waitForFunction(() => window.engineStarts[0]?.ready);
    expect(await page.evaluate(() => Boolean(window.latex))).toBe(false);
    expect(await page.locator('#root').textContent()).toBe('');
  } finally { release(); }
  await page.waitForFunction(() => window.engineStarts[0]?.magic === '%PDF-');
  await expect.poll(() => page.evaluate(() => window.engineStarts[0].terminated)).toBe(1);
  const workers = await page.evaluate(() => window.engineStarts);
  expect(workers).toHaveLength(1);
  expect(workers[0].magic).toBe('%PDF-');
  expect(await page.evaluate(() => window.latex.timings().compile.initializationMs)).toBe(0);
  expect(engineRequests.filter(url => url.includes('.wasm'))).toHaveLength(1);
  expect(engineRequests.filter(url => url.includes('/formats/'))).toHaveLength(1);
});

test('the app adopts a still-loading early worker without restarting its downloads', async ({ page, context }) => {
  await observeWorkers(page);
  let release;
  const hold = new Promise(resolve => { release = resolve; });
  await context.route(/\/compiler\/swiftlatexpdftex\.wasm$/, async route => {
    await hold;
    await route.continue();
  });
  await page.goto('/#workspace');
  try {
    await page.waitForFunction(() => Boolean(window.latex));
    await expect.poll(() => page.evaluate(() => window.latex.timings().compile)).toBeNull();
    expect(await page.evaluate(() => window.engineStarts.length)).toBe(1);
    expect(await page.evaluate(() => window.engineStarts[0].ready)).toBeUndefined();
  } finally { release(); }
  await page.waitForFunction(() => window.engineStarts[0]?.magic === '%PDF-');
  expect(await page.evaluate(() => window.engineStarts.length)).toBe(1);
});

test('direct permalink startup is early but projects do not allocate a compiler', async ({ page }) => {
  await observeWorkers(page);
  await page.goto('/');
  await page.waitForFunction(() => Boolean(window.latex));
  expect(await page.evaluate(() => window.engineStarts)).toEqual([]);
  await page.goto('/documents/missing/Abcd1234');
  await page.waitForFunction(() => window.engineStarts[0]?.ready);
  expect(await page.evaluate(() => window.engineStarts.length)).toBe(1);
});
