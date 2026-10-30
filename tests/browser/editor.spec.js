import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { sourceEditor, editorReady, fillSource, expectSource } from './source-editor.js';

const titleEditor = page => page.getByRole('textbox', { name: 'Document title', exact: true });
const localDocuments = page => page.getByRole('navigation', { name: 'Local documents' }).getByRole('button');
const saved = page => page.getByRole('status').filter({ hasText: 'Saved on this device' });

async function observeStorage(page) {
  await page.addInitScript(() => {
    window.draftWrites = 0;
    window.saveDelay = 0;
    const put = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put = function (...args) {
      window.draftWrites++;
      if (window.failDraftWrites) throw new DOMException('Storage is full', 'QuotaExceededError');
      return put.apply(this, args);
    };
    const complete = Object.getOwnPropertyDescriptor(IDBTransaction.prototype, 'oncomplete');
    Object.defineProperty(IDBTransaction.prototype, 'oncomplete', {
      ...complete,
      set(handler) {
        complete.set.call(this, event => {
          const delay = window.saveDelay;
          if (delay) setTimeout(() => handler.call(this, event), delay);
          else handler.call(this, event);
        });
      },
    });
  });
}

async function fakeEngine(page) {
  await page.addInitScript(() => {
    const NativeWorker = window.Worker;
    window.engineWorkers = [];
    window.engineJobs = [];
    window.engineDelay = 20;
    window.maxConcurrentEngines = 0;
    const observed = new WeakSet();
    new MutationObserver(() => {
      for (const frame of document.querySelectorAll('iframe')) {
        if (observed.has(frame)) continue;
        observed.add(frame);
        if (!window.holdViewer) setTimeout(() => frame.dispatchEvent(new Event('load')), 0);
      }
    }).observe(document, { childList: true, subtree: true });
    window.Worker = class {
      constructor(url, options) {
        if (!String(url).endsWith('/compiler/worker.js')) return new NativeWorker(url, options);
        this.terminated = false;
        this.passes = 0;
        window.engineWorkers.push(this);
        window.maxConcurrentEngines = Math.max(window.maxConcurrentEngines,
          window.engineWorkers.filter(worker => !worker.terminated).length);
        setTimeout(() => this.onmessage?.({ data: { result: 'ok' } }), 30);
      }
      postMessage(message) {
        if (message.cmd === 'writefile') this.source = message.src;
        if (message.cmd === 'compilelatex') {
          if (!this.passes++) window.engineJobs.push({ source: this.source });
          setTimeout(() => this.onmessage?.({ data: {
            cmd: 'compile', result: window.engineFail ? 'error' : 'ok', log: this.source,
            pdf: new TextEncoder().encode(`%PDF-1.4\n${this.source}\n%%EOF`),
          } }), window.engineDelay);
        }
      }
      terminate() { this.terminated = true; }
    };
  });
}

test('switching flushes keystrokes that arrive while a local save is completing', async ({ page }) => {
  await observeStorage(page);
  await page.goto('/#workspace');
  await editorReady(page);
  await fillSource(page, 'first document');
  await titleEditor(page).fill('First');
  await expect(saved(page)).toBeVisible();
  await page.getByRole('button', { name: 'New document' }).click();
  await expect(localDocuments(page)).toHaveCount(2);
  await expect(titleEditor(page)).toHaveValue('Untitled paper');
  await expect(saved(page)).toBeVisible();
  await page.evaluate(() => { window.saveDelay = 500; });
  await fillSource(page, 'before the switch');
  const writes = await page.evaluate(() => window.draftWrites);
  await localDocuments(page).filter({ hasText: 'First' }).click();
  await expect.poll(() => page.evaluate(() => window.draftWrites)).toBeGreaterThan(writes);
  await fillSource(page, 'last keystrokes during the save');
  await expectSource(page, 'first document');
  await page.evaluate(() => { window.saveDelay = 0; });
  await localDocuments(page).filter({ hasText: 'Untitled paper' }).click();
  await expectSource(page, 'last keystrokes during the save');
  await expect(saved(page)).toBeVisible();
  await page.reload();
  await expectSource(page, 'last keystrokes during the save');
});

test('opening warms one engine and compiles immediately; live preview is debounced and persisted', async ({ page }) => {
  await fakeEngine(page);
  await page.goto('/#workspace');
  await expect(page.locator('.preview-status')).toContainText('Compiled in your browser');
  await expect(page.locator('.preview-status')).toContainText(/\d+ ms/);
  await expect(page.locator('.preview-footer')).toContainText('Engine initialized');
  expect(await page.evaluate(() => window.engineWorkers.length)).toBe(1);
  expect(await page.evaluate(() => window.engineJobs.length)).toBe(1);
  const live = page.getByRole('checkbox', { name: 'Live preview' });
  await expect(live).not.toBeChecked();
  await fillSource(page, 'live off edits');
  await expect(saved(page)).toBeVisible();
  expect(await page.evaluate(() => window.engineJobs.length)).toBe(1);
  await live.check();
  await fillSource(page, 'first live edit');
  await fillSource(page, 'latest live edit');
  await expect.poll(() => page.evaluate(() => window.engineJobs.length)).toBe(2);
  await expect(page.locator('.preview-status')).toContainText('Compiled in your browser');
  expect(await page.evaluate(() => window.engineJobs.at(-1).source)).toBe('latest live edit');
  await page.reload();
  await expect(live).toBeChecked();
  await expect(page.locator('.preview-status')).toContainText('Compiled in your browser');
  expect(await page.evaluate(() => window.engineJobs.length)).toBe(1);
  await live.uncheck();
  await fillSource(page, 'no background compile');
  await page.waitForTimeout(1000);
  expect(await page.evaluate(() => window.engineJobs.length)).toBe(1);
});

test('cloud autosave is debounced while Ctrl/Cmd+S only recompiles even unchanged with live preview off', async ({ page }) => {
  await fakeEngine(page);
  let saves = 0;
  let fail = false;
  await page.route('**/api/me', route => route.fulfill({ json: { user: { id: 'owner', username: 'writer' } } }));
  await page.route('**/api/documents', async route => {
    if (route.request().method() === 'GET') return route.fulfill({ json: { documents: [] } });
    saves++;
    await new Promise(resolve => setTimeout(resolve, 60));
    await route.fulfill({ json: { document: { id: 'saved-cloud', revision: saves } } });
  });
  await page.route('**/api/documents/saved-cloud', async route => {
    if (fail) return route.fulfill({ status: 503, json: { error: 'Cloud save unavailable' } });
    saves++;
    await new Promise(resolve => setTimeout(resolve, 60));
    await route.fulfill({ json: { revision: saves } });
  });
  await page.goto('/#workspace');
  await expect(page.locator('.preview-status')).toContainText('Compiled in your browser');
  await expect(page.getByRole('checkbox', { name: 'Live preview' })).not.toBeChecked();
  await editorReady(page);
  expect(saves).toBe(0);
  await page.getByRole('button', { name: 'Save to account' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Saved to your account' })).toContainText(/\d+ ms round trip/);
  await fillSource(page, 'first debounced edit');
  await fillSource(page, 'latest debounced edit');
  await sourceEditor(page).press('Control+s');
  await expect.poll(() => page.evaluate(() => window.engineJobs.length)).toBe(2);
  expect(saves).toBe(1);
  await expect(page.getByRole('status').filter({ hasText: 'Saved to your account' })).toContainText(/\d+ ms round trip/);
  expect(saves).toBe(2);
  await expect(page.locator('.preview-status')).toContainText('Compiled in your browser');
  await sourceEditor(page).press('Control+s');
  await expect.poll(() => page.evaluate(() => window.engineJobs.length)).toBe(3);
  await sourceEditor(page).press('Meta+s');
  await expect.poll(() => page.evaluate(() => window.engineJobs.length)).toBe(4);
  await page.waitForTimeout(1000);
  await expect(page.getByRole('button', { name: 'Save to account' })).toBeEnabled();
  expect(saves).toBe(2);
  expect(await page.evaluate(() => window.maxConcurrentEngines)).toBe(1);
  fail = true;
  await fillSource(page, 'failed automatic cloud save stays local');
  await expect(page.locator('.error-banner')).toContainText('Cloud save unavailable');
  await expect(page.getByRole('status').filter({ hasText: 'Cloud save failed' })).not.toContainText('round trip');
});

test('cloud autosave coalesces in-flight edits and carries the latest server revision', async ({ page }) => {
  await fakeEngine(page);
  const updates = [];
  let concurrent = 0, maximum = 0;
  await page.route('**/api/me', route => route.fulfill({ json: { user: { id: 'owner', username: 'writer' } } }));
  await page.route('**/api/documents', route => route.fulfill({ json: route.request().method() === 'GET'
    ? { documents: [] } : { document: { id: 'coalesced-cloud', revision: 1 } } }));
  await page.route('**/api/documents/coalesced-cloud', async route => {
    const body = route.request().postDataJSON();
    updates.push(body);
    maximum = Math.max(maximum, ++concurrent);
    await new Promise(resolve => setTimeout(resolve, 1200));
    concurrent--;
    await route.fulfill({ json: { revision: body.revision + 1 } });
  });
  await page.goto('/#workspace');
  await editorReady(page);
  await page.getByRole('button', { name: 'Save to account' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Saved to your account' })).toBeVisible();
  await fillSource(page, 'first request');
  await expect.poll(() => updates.length).toBe(1);
  await fillSource(page, 'intermediate edit');
  await fillSource(page, 'latest edit during request');
  await expect.poll(() => updates.length).toBe(2);
  await expect(page.getByRole('status').filter({ hasText: 'Saved to your account' })).toBeVisible();
  expect(updates.map(item => [item.source, item.revision])).toEqual([
    ['first request', 1], ['latest edit during request', 2],
  ]);
  expect(maximum).toBe(1);
  await page.reload();
  await expectSource(page, 'latest edit during request');
});

test('signed-out Ctrl/Cmd+S compiles without opening sign-in or sending a save', async ({ page }) => {
  await fakeEngine(page);
  const writes = [];
  page.on('request', request => {
    if (request.url().includes('/api/') && request.method() !== 'GET') writes.push(request.url());
  });
  await page.goto('/#workspace');
  await editorReady(page);
  await expect(page.locator('.preview-status')).toContainText('Compiled in your browser');
  await sourceEditor(page).press('Control+s');
  await expect.poll(() => page.evaluate(() => window.engineJobs.length)).toBe(2);
  await sourceEditor(page).press('Meta+s');
  await expect.poll(() => page.evaluate(() => window.engineJobs.length)).toBe(3);
  await expect(page.getByRole('dialog')).toHaveCount(0);
  expect(writes).toEqual([]);
});

test('later compile requests replace in-flight work and ignore its late completion', async ({ page }) => {
  await fakeEngine(page);
  await page.goto('/#workspace');
  await expect(page.locator('.preview-status')).toContainText('Compiled in your browser');
  await page.getByRole('checkbox', { name: 'Live preview' }).check();
  await page.evaluate(() => { window.engineDelay = 400; });
  await fillSource(page, 'older request');
  await sourceEditor(page).press('Control+Enter');
  await expect.poll(() => page.evaluate(() => window.engineJobs.length)).toBe(2);
  await fillSource(page, 'newest request');
  await sourceEditor(page).press('Control+Enter');
  await expect.poll(() => page.evaluate(() => window.engineJobs.length)).toBe(3);
  await expect(page.getByRole('button', { name: 'Cancel', exact: true })).toBeVisible();
  expect(await page.evaluate(() => window.engineWorkers[1].terminated)).toBe(true);
  await expect(page.locator('.preview-status')).toContainText('Compiled in your browser');
  await expect(page.locator('.preview-status')).not.toContainText('out of date');
  await page.locator('.compile-log summary').click();
  await expect(page.locator('.compile-log')).toContainText('newest request');
  expect(await page.evaluate(() => window.engineJobs.length)).toBe(3);
  expect(await page.evaluate(() => window.maxConcurrentEngines)).toBe(1);
});

test('PDF handoff retains the old viewer until replacement loads, cancels stale viewers and skips unchanged bytes', async ({ page }) => {
  await fakeEngine(page);
  await page.addInitScript(() => {
    window.revokedUrls = [];
    const revoke = URL.revokeObjectURL;
    URL.revokeObjectURL = url => { window.revokedUrls.push(url); revoke.call(URL, url); };
  });
  await page.goto('/#workspace');
  await expect(page.locator('.preview-status')).toContainText('Compiled in your browser');
  const active = page.locator('iframe[title="Compiled PDF"]');
  const original = await active.getAttribute('src');
  const originalNode = await active.elementHandle();
  await page.evaluate(() => { window.holdViewer = true; });
  await fillSource(page, 'first replacement');
  await sourceEditor(page).press('Control+Enter');
  const pending = page.locator('iframe[title="Loading compiled PDF"]');
  await expect(pending).toHaveCount(1);
  const discarded = await pending.getAttribute('src');
  await expect(active).toHaveAttribute('src', original);
  expect(await originalNode.evaluate(node => node.isConnected)).toBe(true);
  expect(await page.evaluate(url => window.revokedUrls.includes(url.split('#')[0]), original)).toBe(false);
  const exported = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export PDF' }).click();
  expect(await readFile(await (await exported).path(), 'utf8')).toContain('first replacement');
  await fillSource(page, 'latest replacement');
  await sourceEditor(page).press('Control+Enter');
  await expect(pending).not.toHaveAttribute('src', discarded);
  await expect(page.locator('iframe')).toHaveCount(2);
  expect(await page.evaluate(url => window.revokedUrls.includes(url.split('#')[0]), discarded)).toBe(true);
  await expect(active).toHaveAttribute('src', original);
  const latest = await pending.getAttribute('src');
  const stagedNode = await pending.elementHandle();
  await page.emulateMedia({ reducedMotion: 'reduce' });
  expect(await pending.evaluate(frame => getComputedStyle(frame).transitionDuration)).toBe('0s');
  await pending.dispatchEvent('load');
  await expect(active).toHaveAttribute('src', latest);
  await expect(pending).toHaveCount(0);
  expect(await stagedNode.evaluate(node => node === document.querySelector('iframe[title="Compiled PDF"]'))).toBe(true);
  expect(await page.evaluate(url => window.revokedUrls.includes(url.split('#')[0]), original)).toBe(true);
  const count = await page.evaluate(() => window.engineJobs.length);
  await sourceEditor(page).press('Control+Enter');
  await expect.poll(() => page.evaluate(() => window.engineJobs.length)).toBe(count + 1);
  await expect(page.locator('.preview-status')).toContainText('Compiled in your browser');
  await expect(page.locator('iframe')).toHaveCount(1);
  expect(await stagedNode.evaluate(node => node.isConnected)).toBe(true);
  await page.evaluate(() => { window.engineFail = true; });
  await fillSource(page, 'invalid source');
  await sourceEditor(page).press('Control+Enter');
  await expect(page.locator('.preview-status')).toContainText('LaTeX could not compile');
  await expect(active).toHaveAttribute('src', latest);
  await expect(page.locator('.preview-status')).toContainText('out of date');
  expect(await page.evaluate(url => window.revokedUrls.includes(url.split('#')[0]), latest)).toBe(false);
  await page.evaluate(() => { window.engineFail = false; window.engineDelay = 400; });
  await sourceEditor(page).press('Control+Enter');
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(active).toHaveAttribute('src', latest);
  await page.getByRole('button', { name: 'New document' }).click();
  await expect(active).toHaveCount(0);
});

for (const viewport of [{ width: 1920, height: 1080 }, { width: 1366, height: 768 }, { width: 390, height: 844 }]) {
  test(`preview geometry stays stable through compile, loading, ready, cancellation and errors at ${viewport.width}px`, async ({ page }) => {
    await fakeEngine(page);
    await page.setViewportSize(viewport);
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.goto('/#workspace');
    await expect(page.locator('.preview-status')).toContainText('Compiled in your browser');
    if (viewport.width < 1050) await page.getByRole('button', { name: 'PDF preview', exact: true }).click();
    const geometry = () => page.evaluate(() => Object.fromEntries([
      '.preview-toolbar', '.preview-status', '.pdf-area', '.compile-log-slot', '.preview-footer',
      '.preview-actions .compile-button', '.preview-actions .quiet', '.live-preview', '.editor-container',
    ].map(selector => {
      const box = document.querySelector(selector).getBoundingClientRect();
      return [selector, { x: box.x, y: box.y, width: box.width, height: box.height }];
    })));
    const stable = await geometry();
    const assertStable = async () => {
      expect(await geometry()).toEqual(stable);
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(viewport.width);
    };
    await page.evaluate(() => { window.engineDelay = 200; window.holdViewer = true; });
    if (viewport.width < 1050) await page.getByRole('button', { name: 'Source', exact: true }).click();
    await fillSource(page, 'geometry replacement');
    if (viewport.width < 1050) await page.getByRole('button', { name: 'PDF preview', exact: true }).click();
    await page.getByRole('button', { name: 'Compile', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Cancel', exact: true })).toBeVisible();
    await assertStable();
    const pending = page.locator('iframe[title="Loading compiled PDF"]');
    await expect(pending).toHaveCount(1);
    await assertStable();
    await pending.dispatchEvent('load');
    await expect(pending).toHaveCount(0);
    await assertStable();
    await page.getByRole('button', { name: 'Compile', exact: true }).click();
    await page.getByRole('button', { name: 'Cancel', exact: true }).click();
    await assertStable();
    await page.evaluate(() => { window.engineFail = true; });
    await page.getByRole('button', { name: 'Compile', exact: true }).click();
    await expect(page.locator('.preview-status')).toContainText('LaTeX could not compile');
    await expect(page.locator('.compile-log')).toHaveAttribute('open', '');
    await assertStable();
    await page.locator('.compile-log summary').click();
    await assertStable();
    await page.evaluate(() => { window.engineFail = false; });
    await page.getByRole('button', { name: 'Compile', exact: true }).click();
    await expect(page.locator('.preview-status')).toContainText('Compiled in your browser');
    await assertStable();
  });
}

test('desktop panes fill available width while tablet and enlarged text reflow without clipping controls', async ({ page }) => {
  await fakeEngine(page);
  await page.goto('/#workspace');
  await expect(page.locator('.preview-status')).toContainText('Compiled in your browser');
  for (const viewport of [{ width: 1920, height: 1080 }, { width: 1366, height: 768 }]) {
    await page.setViewportSize(viewport);
    const sizes = await page.evaluate(() => {
      const box = selector => document.querySelector(selector).getBoundingClientRect();
      const editor = box('.editor-panel'), preview = box('.preview-panel'), sidebar = box('.sidebar'), pdf = box('.pdf-area');
      return { editor: editor.width, preview: preview.width, sidebar: sidebar.width, right: preview.right, pdfHeight: pdf.height, viewport: innerWidth, scroll: document.documentElement.scrollWidth };
    });
    expect(sizes.scroll).toBe(viewport.width);
    expect(sizes.right).toBe(viewport.width);
    expect(sizes.editor + sizes.preview + sizes.sidebar).toBeCloseTo(viewport.width, 0);
    expect(Math.abs(sizes.editor - sizes.preview)).toBeLessThan(1);
    expect(sizes.editor).toBeGreaterThan(viewport.width * .4);
    expect(sizes.pdfHeight).toBeGreaterThan(viewport.height * (viewport.width >= 1920 ? .65 : .5));
  }
  for (const viewport of [{ width: 1024, height: 768 }, { width: 960, height: 540 }, { width: 390, height: 844 }]) {
    await page.setViewportSize(viewport);
    await expect(sourceEditor(page)).toBeVisible();
    await expect(page.getByRole('button', { name: 'Compile', exact: true })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(viewport.width);
    await page.getByRole('button', { name: 'PDF preview', exact: true }).click();
    await expect(page.getByRole('checkbox', { name: 'Live preview' })).toBeVisible();
    expect(await page.locator('.pdf-area').evaluate(element => element.getBoundingClientRect().width)).toBe(viewport.width);
    if (viewport.height <= 600) expect(await page.locator('.pdf-area').evaluate(element => element.getBoundingClientRect().height)).toBeGreaterThan(240);
    await page.getByRole('button', { name: 'Source', exact: true }).click();
  }
  await page.setViewportSize({ width: 1920, height: 1080 });
  await page.evaluate(() => { document.documentElement.style.fontSize = '34px'; });
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(1920);
  await expect(page.getByRole('checkbox', { name: 'Live preview' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Save to account' })).toBeVisible();
});

test('mobile controls have readable text, 44px targets, labels and narrow/zoom reflow', async ({ page }) => {
  await fakeEngine(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/#workspace');
  await editorReady(page);
  await expect(page.getByRole('button', { name: 'Compile', exact: true })).toBeVisible();
  expect(await sourceEditor(page).evaluate(input => parseFloat(getComputedStyle(input).fontSize))).toBeGreaterThanOrEqual(16);
  const checkTargets = async () => {
    const undersized = await page.locator('button,a[href],input:not([type=file])').evaluateAll(controls => controls.filter(control => control.getClientRects().length).flatMap(control => {
      const target = control.type === 'checkbox' ? control.closest('label') : control;
      const box = target.getBoundingClientRect();
      return box.width < 43.9 || box.height < 43.9 ? [{ name: control.getAttribute('aria-label') || control.textContent, width: box.width, height: box.height }] : [];
    }));
    expect(undersized).toEqual([]);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(await page.evaluate(() => window.innerWidth));
  };
  await checkTargets();
  await page.getByRole('button', { name: 'PDF preview', exact: true }).click();
  await expect(page.getByRole('checkbox', { name: 'Live preview' })).toBeVisible();
  await checkTargets();
  await page.getByRole('button', { name: 'Toggle documents' }).click();
  await expect(page.getByRole('button', { name: 'Toggle documents' })).toHaveAttribute('aria-expanded', 'true');
  await checkTargets();
  await page.getByRole('button', { name: 'Toggle documents' }).click();
  await page.setViewportSize({ width: 720, height: 600 });
  await checkTargets();
  await page.setViewportSize({ width: 320, height: 844 });
  await checkTargets();
  await page.getByRole('button', { name: 'Source', exact: true }).click();
  await page.evaluate(() => { document.documentElement.style.fontSize = '34px'; });
  await checkTargets();
  const reflow = await page.evaluate(() => {
    const state = document.querySelector('.save-state').getBoundingClientRect();
    return {
      stateWidth: state.width, stateHeight: state.height,
      overflow: ['.topbar', '.top-actions', '.document-toolbar', '.document-actions', '.source-toolbar', '.mobile-tabs'].filter(selector => {
        const el = document.querySelector(selector);
        return el.scrollWidth > el.clientWidth + 1;
      }),
    };
  });
  expect(reflow.stateWidth).toBeGreaterThan(200);
  expect(reflow.stateHeight).toBeLessThan(120);
  expect(reflow.overflow).toEqual([]);
  await sourceEditor(page).scrollIntoViewIfNeeded();
  await expect(sourceEditor(page)).toBeVisible();
  await expect(page.getByRole('button', { name: 'Save to account' })).toBeVisible();
});

test('editor chrome, source and dialogs use one restrained visual system', async ({ page }) => {
  await fakeEngine(page);
  await page.setViewportSize({ width: 1920, height: 1080 });
  await page.goto('/#workspace');
  await editorReady(page);
  await expect(page.locator('.topbar')).toHaveCSS('background-color', 'rgb(22, 22, 22)');
  await expect(page.locator('.source-toolbar')).toHaveCSS('background-color', 'rgb(24, 32, 39)');
  await expect(page.locator('.preview-toolbar')).toHaveCSS('background-color', 'rgb(35, 42, 48)');
  await expect(page.locator('.preview-panel')).toHaveCSS('background-color', 'rgb(32, 32, 32)');
  await expect(page.locator('.preview-status')).toHaveCSS('background-color', 'rgb(32, 32, 32)');
  await expect(page.locator('.compile-log')).toHaveCSS('background-color', 'rgb(35, 42, 48)');
  await expect(page.locator('.preview-footer')).toHaveCSS('background-color', 'rgb(35, 42, 48)');
  const pdf = page.locator('iframe[title="Compiled PDF"]');
  await expect(pdf).toHaveCSS('background-color', 'rgb(255, 255, 255)');
  await expect(pdf).toHaveCSS('color-scheme', 'light');
  await expect(pdf).toHaveCSS('filter', 'none');
  await expect(page.locator('.source-file-tab')).toHaveText('main.tex');
  expect(await page.locator('.topbar').evaluate(el => el.getBoundingClientRect().height)).toBe(56);
  expect(await page.locator('.document-toolbar').evaluate(el => el.getBoundingClientRect().height)).toBe(64);
  expect(await page.locator('.preview-toolbar').evaluate(el => el.getBoundingClientRect().height)).toBe(56);
  await page.getByRole('button', { name: 'Help', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCSS('background-color', 'rgb(32, 32, 32)');
  await page.getByRole('button', { name: 'Close help' }).press('Escape');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCSS('background-color', 'rgb(32, 32, 32)');
  await expect(page.getByRole('textbox', { name: 'Username' })).toHaveCSS('background-color', 'rgb(41, 41, 41)');
});

test('help and sign-in dialogs trap keyboard focus and restore it on Escape', async ({ page }) => {
  await fakeEngine(page);
  await page.goto('/#workspace');
  const help = page.getByRole('button', { name: 'Help', exact: true });
  await help.focus();
  await help.press('Enter');
  const dialog = page.getByRole('dialog');
  const closeHelp = page.getByRole('button', { name: 'Close help' });
  await expect(closeHelp).toBeFocused();
  await closeHelp.press('Shift+Tab');
  await expect(dialog.getByRole('link')).toBeFocused();
  await dialog.getByRole('link').press('Tab');
  await expect(closeHelp).toBeFocused();
  await closeHelp.press('Escape');
  await expect(dialog).toHaveCount(0);
  await expect(help).toBeFocused();
  const signIn = page.getByRole('button', { name: /Sign in/ });
  await signIn.focus();
  await signIn.press('Enter');
  await expect(page.getByRole('textbox', { name: 'Username' })).toBeFocused();
  const password = page.getByLabel('Password', { exact: true });
  await expect(password).toHaveAttribute('minlength', '8');
  await expect(password).toHaveAttribute('maxlength', '128');
  await expect(dialog).toContainText('Password: 8-128 characters.');
  const closeSignIn = page.getByRole('button', { name: 'Close sign in' });
  await closeSignIn.focus();
  await closeSignIn.press('Shift+Tab');
  await expect(page.getByRole('button', { name: 'New here? Create an account' })).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await expect(signIn).toBeFocused();
});

test('long account names retain an explicit mobile sign-out action without overflowing', async ({ page }) => {
  await fakeEngine(page);
  const username = 'a'.repeat(32);
  await page.route('**/api/me', route => route.fulfill({ json: { user: { id: 'owner', username } } }));
  await page.route('**/api/documents', route => route.fulfill({ json: { documents: [] } }));
  await page.setViewportSize({ width: 320, height: 844 });
  await page.goto('/#workspace');
  await expect(page.getByRole('button', { name: `Sign out ${username}` })).toBeVisible();
  await expect(page.locator('.account-name')).toBeHidden();
  await expect(page.getByRole('button', { name: `Sign out ${username}` }).locator('span:last-child')).toHaveText('Sign out');
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(320);
  await page.getByRole('button', { name: 'Help', exact: true }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(320);
  await page.getByRole('button', { name: 'Close help' }).press('Escape');
});

test('reopening a linked cloud draft replaces visible inputs and persists the fetched text', async ({ page }) => {
  let cloud = { id: 'cloud-document', title: 'Cloud title', source: 'original cloud text', revision: 1 };
  await page.route('**/api/me', route => route.fulfill({ json: { user: { id: 'owner', username: 'writer' } } }));
  await page.route('**/api/documents', route => route.fulfill({ json: { documents: [cloud] } }));
  await page.route('**/api/documents/cloud-document', route => route.fulfill({ json: { document: cloud } }));
  await page.goto('/#workspace');
  await editorReady(page);
  const openCloud = page.getByRole('navigation', { name: 'Cloud documents' }).getByRole('button');
  await openCloud.click();
  await expectSource(page, 'original cloud text');
  await fillSource(page, 'local edits not yet debounced');
  cloud = { ...cloud, title: 'Updated cloud title', source: 'new cloud text', revision: 2 };
  let prompted = false;
  page.once('dialog', async dialog => { prompted = true; await dialog.accept(); });
  await openCloud.click();
  await expectSource(page, 'new cloud text');
  await expect(titleEditor(page)).toHaveValue('Updated cloud title');
  expect(prompted).toBe(true);
  await expect(page.getByRole('status').filter({ hasText: 'Saved to your account' })).toBeVisible();
  await page.reload();
  await expectSource(page, 'new cloud text');
  await expect(titleEditor(page)).toHaveValue('Updated cloud title');
});

test('typing is debounced, keeps the editor node and does not send source to the API', async ({ page }) => {
  await observeStorage(page);
  const apiWrites = [];
  page.on('request', request => {
    if (request.url().includes('/api/') && request.method() !== 'GET') apiWrites.push(request.url());
  });
  await page.goto('/#workspace');
  await editorReady(page);
  const editor = await sourceEditor(page).elementHandle();
  const writes = await page.evaluate(() => window.draftWrites);
  await fillSource(page, 'typing ');
  await sourceEditor(page).pressSequentially('a short burst');
  await expect(saved(page)).toBeVisible();
  expect(await page.evaluate(() => window.draftWrites)).toBe(writes + 1);
  expect(await editor.evaluate(node => node === document.querySelector('textarea'))).toBe(true);
  await sourceEditor(page).blur();
  expect(await page.evaluate(() => window.draftWrites)).toBe(writes + 1);
  expect(apiWrites).toEqual([]);
});

test('a failed local write keeps the current source exportable and retries the latest edits', async ({ page }) => {
  await observeStorage(page);
  await page.goto('/#workspace');
  await editorReady(page);
  await page.evaluate(() => { window.failDraftWrites = true; });
  await fillSource(page, 'source to recover');
  await expect(page.locator('.error-banner')).toContainText('Storage is full');
  await expect(page.getByRole('status').filter({ hasText: 'Local save failed' })).toBeVisible();
  await page.getByRole('button', { name: 'New document' }).click();
  await expectSource(page, 'source to recover');
  await expect(localDocuments(page)).toHaveCount(1);
  const exported = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export .tex' }).click();
  expect(await readFile(await (await exported).path(), 'utf8')).toBe('source to recover');
  await page.evaluate(() => { window.failDraftWrites = false; });
  await fillSource(page, 'latest recovered source');
  await expect(saved(page)).toBeVisible();
  await page.reload();
  await expectSource(page, 'latest recovered source');
});

test('Tab respects the source limit, Shift+Tab leaves the editor, and mobile export stays accessible', async ({ page }) => {
  await page.goto('/#workspace');
  await editorReady(page);
  const text = 'x'.repeat(99999);
  await fillSource(page, text);
  await sourceEditor(page).press('Control+End');
  await sourceEditor(page).press('Tab');
  await expectSource(page, text);
  await sourceEditor(page).press('Shift+Tab');
  await expect(sourceEditor(page)).not.toBeFocused();
  await fillSource(page, 'abcd');
  await sourceEditor(page).press('Control+Home');
  await sourceEditor(page).press('ArrowRight');
  await sourceEditor(page).press('Shift+ArrowRight');
  await sourceEditor(page).press('Shift+ArrowRight');
  await sourceEditor(page).press('Tab');
  await expectSource(page, 'a d');
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(sourceEditor(page)).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(390);
  const exported = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export .tex' }).click();
  expect(await readFile(await (await exported).path(), 'utf8')).toBe('a d');
  await page.getByRole('button', { name: 'Toggle documents' }).click();
  await expect(page.getByRole('button', { name: 'Import .tex file' })).toBeVisible();
  await page.locator('input[type=file]').setInputFiles({ name: 'mobile.tex', mimeType: 'text/plain', buffer: Buffer.from('imported mobile source') });
  await expectSource(page, 'imported mobile source');
  await expect(saved(page)).toBeVisible();
});
