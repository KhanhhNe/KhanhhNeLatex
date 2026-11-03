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
          if (data.cmd === 'compile') record.compiles = (record.compiles || 0) + 1;
          if (data.cmd === 'compile' && data.result === 'ok') record.magic = new TextDecoder().decode(new Uint8Array(data.pdf).slice(0, 5));
        });
      }
    };
  });
}

test('engine becomes ready while main JS and CSS are held, then the app adopts it once', async ({ page }) => {
  await observeWorkers(page);
  const engineRequests = [];
  page.context().on('request', request => {
    if (/\/compiler\/(?:swiftlatexpdftex\.wasm|formats\/pdftex-|tex\/)/.test(request.url())) engineRequests.push(request.url());
  });
  let release;
  const hold = new Promise(resolve => { release = resolve; });
  await page.route(/\/assets\/index-[^/]+\.(?:js|css)$/, async route => {
    await hold;
    await route.continue();
  });
  await page.goto('/#workspace', { waitUntil: 'commit' });
  try {
    await page.waitForFunction(() => window.engineStarts[0]?.ready, null, { polling: 50 });
    expect(await page.evaluate(() => Boolean(window.latex))).toBe(false);
    expect(await page.locator('#root').textContent()).toBe('');
  } finally { release(); }
  await page.waitForFunction(() => window.engineStarts[0]?.magic === '%PDF-');
  await page.waitForTimeout(250);
  expect(await page.evaluate(() => window.engineStarts[0].terminated)).toBe(0);
  const workers = await page.evaluate(() => window.engineStarts);
  expect(workers).toHaveLength(1);
  expect(workers[0].magic).toBe('%PDF-');
  expect(await page.evaluate(() => window.latex.timings().compile.initializationMs)).toBe(0);
  expect(engineRequests.filter(url => url.includes('.wasm'))).toHaveLength(1);
  expect(engineRequests.filter(url => url.includes('/formats/'))).toHaveLength(1);
  const packageRequests = engineRequests.filter(url => url.includes('/tex/'));
  expect(packageRequests).toHaveLength(44);
  expect(new Set(packageRequests).size).toBe(packageRequests.length);
});

test('the app adopts a still-loading early worker without restarting its downloads', async ({ page, context }) => {
  await observeWorkers(page);
  let release;
  const hold = new Promise(resolve => { release = resolve; });
  await context.route(/\/compiler\/swiftlatexpdftex\.wasm(?:\?v=[a-f0-9]+)?$/, async route => {
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

test('an early worker held by a debugger that never resumes it is replaced and the app still compiles', async ({ page, context, browserName }) => {
  test.skip(browserName !== 'chromium', 'Uses Chromium DevTools auto-attach');
  await observeWorkers(page);
  const cdp = await context.newCDPSession(page);
  let held = false;
  cdp.on('Target.attachedToTarget', ({ sessionId, targetInfo }) => {
    // Mimic a client that misses the first compiler worker: it stays paused before its script loads.
    // Detaching any other waiting session lets that worker run.
    if (!held && targetInfo.url.includes('/compiler/worker.js')) { held = true; return; }
    cdp.send('Target.detachFromTarget', { sessionId }).catch(() => {});
  });
  await cdp.send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: true, flatten: true });
  await page.goto('/#workspace');
  await expect(page.getByText(/Compiled in your browser/)).toBeVisible({ timeout: 40000 });
  const workers = await page.evaluate(() => window.engineStarts);
  expect(workers.length).toBe(2);
  expect(workers[0].terminated).toBeGreaterThan(0);
  expect(workers[0].ready).toBeUndefined();
  expect(workers[1].magic).toBe('%PDF-');
});

test('switching between documents reuses one warm engine without reloading packages', async ({ page }) => {
  await observeWorkers(page);
  const engineRequests = [];
  page.context().on('request', request => {
    if (/\/compiler\/(?:swiftlatexpdftex\.wasm|formats\/pdftex-|tex\/)/.test(request.url())) engineRequests.push(request.url());
  });
  await page.goto('/#workspace');
  await page.waitForFunction(() => window.engineStarts[0]?.magic === '%PDF-');
  const doc = n => String.raw`\documentclass{article}
\begin{document}
\section{Document ${n}}\label{s}
See \ref{s}. Only-in-${n}.
\end{document}`;
  const ids = [];
  for (const n of ['one', 'two', 'three']) {
    ids.push(await page.evaluate(async source => {
      const done = new Promise(resolve => { const off = window.latex.on('compile', event => { if (!event.cancelled) { off(); resolve(); } }); });
      await window.latex.create({ title: `Warm ${source.length}-${Math.random()}`, source });
      await done;
      return window.latex.current().id;
    }, doc(n)));
  }
  const requestsBeforeSwitches = engineRequests.length;
  const switches = [];
  for (const id of [ids[0], ids[2], ids[1], ids[0], ids[1], ids[2]]) {
    switches.push(await page.evaluate(async id => {
      const done = new Promise(resolve => {
        const off = window.latex.on('compile', event => { if (event.documentId === id && !event.cancelled) { off(); resolve(event); } });
      });
      await window.latex.open(id);
      const event = await done;
      return { ok: event.ok, initializationMs: event.timings?.initializationMs, log: window.latex.log() };
    }, id));
  }
  // Rapid switching cancels in-flight work without replacing the engine or leaking older results.
  const rapid = await page.evaluate(async ids => {
    const done = new Promise(resolve => {
      const off = window.latex.on('compile', event => { if (event.documentId === ids[1] && !event.cancelled) { off(); resolve(event); } });
    });
    window.latex.open(ids[2]);
    window.latex.open(ids[0]);
    await window.latex.open(ids[1]);
    const event = await done;
    return { ok: event.ok, current: window.latex.current().id, log: window.latex.log() };
  }, ids);
  for (const result of switches) {
    expect(result.ok).toBe(true);
    expect(result.initializationMs).toBe(0);
    expect(result.log.text).not.toContain('undefined references');
  }
  expect(rapid).toMatchObject({ ok: true, current: ids[1] });
  const workers = await page.evaluate(() => window.engineStarts);
  expect(workers).toHaveLength(1);
  expect(workers[0]).toMatchObject({ terminated: 0, magic: '%PDF-' });
  expect(workers[0].compiles).toBeGreaterThanOrEqual(2 * (1 + 3 + switches.length + 1));
  expect(engineRequests.slice(requestsBeforeSwitches)).toEqual([]);
  expect(engineRequests.filter(url => url.includes('.wasm'))).toHaveLength(1);
  expect(engineRequests.filter(url => url.includes('/formats/'))).toHaveLength(1);
});
