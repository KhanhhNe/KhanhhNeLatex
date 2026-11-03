import { test, expect, devices } from '@playwright/test';
import { join } from 'node:path';

const source = (count, label = 'Status') => String.raw`\documentclass{article}\begin{document}` +
  Array.from({ length: count }, (_, index) => `${label} ${index + 1}${index < count - 1 ? String.raw`\newpage` : ''}`)
    .join('\n') + String.raw`\end{document}`;
const shown = '.pdf-viewer:not(.pending)';
const status = page => page.locator('.preview-page-status');

async function compile(page, count, label) {
  const result = await page.evaluate(async text => {
    latex.setSource(text);
    return latex.compile();
  }, source(count, label));
  expect(result.ok).toBe(true);
  await page.evaluate(() => latex.preview());
  await expect(page.locator('.pdf-viewer.pending')).toHaveCount(0);
  await page.evaluate(() => latex.show('preview'));
}

async function goToPage(page, number) {
  // Fit/resize anchors apply on the next frame and must finish before this intentional scroll.
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  await expect(page.locator(`${shown} .pdf-pages`)).toHaveCSS('transform', 'none');
  await page.locator(`${shown} .pdf-viewport`).evaluate((view, number) => {
    const paper = view.querySelectorAll('.pdf-page')[number - 1];
    const box = paper.getBoundingClientRect(), viewport = view.getBoundingClientRect();
    view.scrollTop += box.top + box.height / 2 - viewport.top - view.clientHeight / 2;
  }, number);
}

async function expectDominantPage(page, total) {
  const number = await page.locator(`${shown} .pdf-viewport`).evaluate(view => {
    const viewport = view.getBoundingClientRect();
    return [...view.querySelectorAll('.pdf-page')].map((paper, index) => {
      const box = paper.getBoundingClientRect();
      return { number: index + 1, area: Math.max(0, Math.min(box.bottom, viewport.bottom) - Math.max(box.top, viewport.top)) *
        Math.max(0, Math.min(box.right, viewport.right) - Math.max(box.left, viewport.left)) };
    }).sort((a, b) => b.area - a.area)[0].number;
  });
  await expect(status(page)).toHaveText(`Page ${number}/${total}`);
}

for (const mobile of [false, true]) {
  test(`${mobile ? 'mobile' : 'desktop'} page status follows dominant paper, zoom, resize, replacement and document switches`, async ({ browser, baseURL }) => {
    const { defaultBrowserType, ...phone } = devices['iPhone 13'];
    const context = await browser.newContext({ baseURL, ...(mobile ? phone : {}) });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    try {
      await page.goto('/#workspace');
      await page.waitForFunction(() => Boolean(window.latex));
      await page.evaluate(() => latex.ready());
      await compile(page, 12);
      await expect(status(page)).toHaveText('Page 1/12');
      await expect(status(page)).toBeVisible();
      expect(await status(page).evaluate(node => Boolean(node.closest('[role="status"],[aria-live]')))).toBe(false);
      await goToPage(page, 6);
      await expect(status(page)).toHaveText('Page 6/12');

      // Scrolling within one page must not rewrite the status or announce scroll events.
      const updates = await status(page).evaluate(async node => {
        let updates = 0;
        const observer = new MutationObserver(() => updates++);
        observer.observe(node, { childList: true, characterData: true, subtree: true });
        const view = document.querySelector('.pdf-viewer:not(.pending) .pdf-viewport');
        for (let index = 0; index < 12; index++) {
          view.scrollTop += index % 2 ? -2 : 2;
          await new Promise(requestAnimationFrame);
        }
        observer.disconnect();
        return updates;
      });
      expect(updates).toBe(0);
      if (mobile) {
        await page.locator(`${shown} .pdf-viewport`).evaluate(view => { view.scrollTop += 24; });
        const restore = page.getByRole('button', { name: 'Show reading controls' });
        await expect(restore).toBeVisible();
        await expect(status(page)).toBeHidden();
        await restore.click();
        await expect(status(page)).toBeVisible();
      }
      await page.getByRole('button', { name: 'Zoom in', exact: true }).click();
      await expectDominantPage(page, 12);
      if (mobile) {
        const restore = page.getByRole('button', { name: 'Show reading controls' });
        if (await restore.isVisible()) await restore.click();
      }
      await page.getByRole('button', { name: 'Fit width', exact: true }).click();
      await page.setViewportSize(mobile ? { width: 844, height: 390 } : { width: 1280, height: 720 });
      await expectDominantPage(page, 12);
      if (process.env.PAGE_STATUS_ARTIFACTS) {
        const restore = page.getByRole('button', { name: 'Show reading controls' });
        if (mobile && await restore.isVisible()) await restore.click();
        await page.screenshot({ path: join(process.env.PAGE_STATUS_ARTIFACTS, mobile ? 'page-status-mobile.png' : 'page-status-desktop.png') });
      }

      await goToPage(page, 12);
      await expect(status(page)).toHaveText('Page 12/12');
      await expect.poll(() => page.locator(`${shown} canvas`).count()).toBeGreaterThan(0);
      await expect.poll(() => page.locator(`${shown} canvas`).count()).toBeLessThanOrEqual(6);
      const oldUrl = await page.locator(shown).getAttribute('data-src');
      // Invalid source retains the last good PDF and its page count.
      const failed = await page.evaluate(async () => {
        latex.setSource(String.raw`\documentclass{article}\begin{document}\badstatuscommand\end{document}`);
        return latex.compile();
      });
      expect(failed.ok).toBe(false);
      await expect(status(page)).toHaveText('Page 12/12');
      await expect(page.locator(shown)).toHaveAttribute('data-src', oldUrl);

      // While a replacement loads, only the still-visible PDF may publish a count.
      await page.evaluate(() => {
        window.pageCountMismatches = [];
        window.statusObserver = new MutationObserver(() => {
          const viewer = document.querySelector('.pdf-viewer:not(.pending)');
          const count = document.querySelector('.preview-page-status')?.textContent;
          if (count && viewer && !count.endsWith(`/${viewer.querySelectorAll('.pdf-page').length}`))
            window.pageCountMismatches.push(count);
        });
        window.statusObserver.observe(document.querySelector('.preview-panel'), { subtree: true, childList: true, characterData: true });
      });
      await compile(page, 3, 'Replacement');
      await expect(page.locator(shown)).not.toHaveAttribute('data-src', oldUrl);
      await expect(status(page)).toHaveText('Page 3/3');
      expect(await page.evaluate(() => { window.statusObserver.disconnect(); return window.pageCountMismatches; })).toEqual([]);
      await goToPage(page, 1);
      await expect(status(page)).toHaveText('Page 1/3');
      await page.evaluate(text => latex.create({ title: 'Different document', source: text }), source(2, 'Other'));
      // No previous-document count may survive a document switch/loading gap.
      await expect(status(page)).not.toHaveText('Page 1/3');
      await page.evaluate(() => latex.preview());
      await expect(status(page)).toHaveText('Page 1/2');
      expect(errors).toEqual([]);
    } finally { await context.close(); }
  });
}

test('page boundaries are stable and wheel momentum updates status without waiting for rasterization', async ({ page }) => {
  await page.goto('/#workspace');
  await page.waitForFunction(() => Boolean(window.latex));
  await page.evaluate(() => latex.ready());
  await compile(page, 10);
  const view = page.locator(`${shown} .pdf-viewport`);
  // Two equally visible pages: subpixel jitter should retain the previously dominant one.
  await goToPage(page, 4);
  await expect(status(page)).toHaveText('Page 4/10');
  await view.evaluate(async view => {
    const [a, b] = [3, 4].map(index => view.querySelectorAll('.pdf-page')[index].getBoundingClientRect());
    const box = view.getBoundingClientRect();
    view.scrollTop += (a.bottom + b.top) / 2 - box.top - view.clientHeight / 2;
    await new Promise(requestAnimationFrame);
    for (let index = 0; index < 10; index++) {
      view.scrollTop += index % 2 ? -1 : 1;
      await new Promise(requestAnimationFrame);
    }
  });
  await expect(status(page)).toHaveText('Page 4/10');
  await view.evaluate(view => { view.scrollTop += 12; });
  await expect(status(page)).toHaveText('Page 5/10');
  const box = await view.boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  for (const delta of [650, 400, 200, 80]) await page.mouse.wheel(0, delta);
  await expectDominantPage(page, 10);
  await goToPage(page, 10);
  await expect(status(page)).toHaveText('Page 10/10');
});

test('read-only shared PDF displays the same page status without editing or persistence', async ({ page }) => {
  const mutations = [];
  page.on('request', request => { if (request.method() !== 'GET') mutations.push(request.url()); });
  await page.route('**/api/shares/*', route => route.fulfill({
    json: { document: { title: 'Shared pages', source: source(5, 'Shared'), updatedAt: new Date().toISOString() } },
  }));
  await page.goto(`/share/${'a'.repeat(64)}`);
  await expect(status(page)).toHaveText('Page 1/5');
  await goToPage(page, 3);
  await expect(status(page)).toHaveText('Page 3/5');
  await goToPage(page, 5);
  await expect(status(page)).toHaveText('Page 5/5');
  expect(await status(page).evaluate(node => Boolean(node.closest('[role="status"],[aria-live]')))).toBe(false);
  await page.getByRole('button', { name: 'View source', exact: true }).click();
  await expect(page.getByRole('region', { name: 'Read-only LaTeX source' })).toBeVisible();
  expect(mutations).toEqual([]);
});

test('initial PDF loading has no guessed or stale page count', async ({ page }) => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  await page.route('**/*pdf.worker*', async route => { await gate; await route.continue(); });
  try {
    await page.goto('/#workspace');
    await expect(page.locator(shown)).toHaveCount(1);
    await expect(status(page)).toHaveCount(0);
    release();
    await expect(status(page)).toHaveText('Page 1/1');
  } finally { release(); }
});
