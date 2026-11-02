import { test, expect, chromium, webkit, devices } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { editorReady, fillSource } from './source-editor.js';

test.use({ channel: 'chromium', deviceScaleFactor: 3 });

const sizes = [
  ['portrait', 390, 844],
  ['landscape', 844, 390],
  ['browser-toolbar-simulation', 390, 664],
  ['keyboard-height-simulation', 390, 300],
  ['landscape-keyboard-height-simulation', 844, 240],
  ['landscape-safe-area-simulation', 844, 390],
];
const title = 'A long project title '.repeat(5).slice(0, 100);
const source = String.raw`\documentclass{article}
\usepackage{color}
\begin{document}
\section{Mobile PDF review}
Black text on white paper. \textcolor{red}{This text stays red.}
\end{document}`;

async function screenshot(page, name) {
  if (process.env.MOBILE_ARTIFACTS)
    await page.screenshot({ path: join(process.env.MOBILE_ARTIFACTS, `${name}.png`), fullPage: !name.includes('auth') });
}

async function reachable(locator, page) {
  await locator.scrollIntoViewIfNeeded();
  await expect(locator).toBeInViewport();
  // Intersection with the window alone misses cropping by an overflow-hidden ancestor.
  await expect(locator).toBeVisible();
  expect(await locator.evaluate(element => {
    const box = element.getBoundingClientRect();
    return document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2)?.closest('button,a,input,label,summary') === element;
  })).toBe(true);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(await page.evaluate(() => innerWidth));
}

async function menuAction(page, name, role = 'button') {
  await page.getByRole('button', { name: 'More actions' }).click();
  const sheet = page.getByRole('dialog', { name: /./ }).filter({ has: page.getByRole('button', { name: 'Close menu' }) });
  await expect(sheet).toBeVisible();
  const action = role === 'label' ? sheet.getByLabel(name, { exact: true }) : sheet.getByRole(role, { name, exact: true });
  await reachable(action, page);
  return action;
}

async function touchTargets(page) {
  const small = await page.locator('button,a,input:not(.inputarea),summary,.live-preview').evaluateAll(elements =>
    elements.filter(element => element.getClientRects().length && !element.closest('[inert]') && element.type !== 'checkbox').flatMap(element => {
      const box = element.getBoundingClientRect();
      return box.width < 43.9 || box.height < 43.9 ? [element.getAttribute('aria-label') || element.textContent] : [];
    }));
  expect(small).toEqual([]);
}

for (const browserType of [chromium, webkit]) {
  for (const [state, width, height] of sizes) {
    test(`${browserType.name()} iPhone 13 Pro ${state}: every surface remains reachable`, async ({ baseURL }) => {
      const browser = await browserType.launch({ channel: browserType === chromium ? 'chromium' : undefined });
      const context = await browser.newContext({ ...devices['iPhone 13 Pro'], viewport: { width, height }, baseURL });
      const page = await context.newPage();
      page.setDefaultTimeout(15000);
      try {
        if (state.includes('safe-area')) {
          // Windows emulation has zero native insets; substitute explicit test insets.
          await page.route('**/assets/index-*.css', async route => {
            const response = await route.fetch();
            const insets = { top: 0, right: 47, bottom: 21, left: 47 };
            const body = (await response.text()).replace(/env\(safe-area-inset-(top|right|bottom|left)\)/g, (_, edge) => `${insets[edge]}px`);
            await route.fulfill({ response, body });
          });
        }
        await page.goto('/');
        expect(await page.locator('meta[name="viewport"]').getAttribute('content')).toContain('viewport-fit=cover');
        await expect(page.getByRole('list', { name: 'Projects' })).toBeVisible();
        const search = page.getByRole('searchbox', { name: 'Search projects' });
        expect((await page.locator('.projects-search').boundingBox()).width).toBeGreaterThanOrEqual(200);
        expect(await search.evaluate(element => parseFloat(getComputedStyle(element).fontSize))).toBeGreaterThanOrEqual(16);
        await search.fill('no matching document');
        await expect(page.getByRole('heading', { name: 'No matching documents' })).toBeVisible();
        const start = page.getByRole('button', { name: 'Start writing' });
        await reachable(start, page);
        await screenshot(page, `${browserType.name()}-${state}-empty`);
        await search.clear();
        await page.getByRole('button', { name: 'Grid view', exact: true }).click();
        await touchTargets(page);
        if (width === 390) {
          const buttons = await Promise.all(['Import .tex', 'New document'].map(name => page.getByRole('button', { name, exact: true }).boundingBox()));
          expect(buttons[0].y).toBe(buttons[1].y);
        }
        await page.getByRole('button', { name: 'Sort by name', exact: false }).click();
        await page.getByRole('button', { name: 'New document', exact: true }).click();
        await editorReady(page);
        if (state === 'portrait') {
          expect(await page.locator('.view-lines').first().evaluate(element => getComputedStyle(element).fontSize)).toBe('14px');
          expect(await page.getByRole('textbox', { name: 'LaTeX source', exact: true })
            .evaluate(element => getComputedStyle(element).fontSize)).toBe('16px');
        }
        const documentTitle = page.getByRole('textbox', { name: 'Document title' });
        expect(await documentTitle.evaluate(element => parseFloat(getComputedStyle(element).fontSize))).toBeGreaterThanOrEqual(16);
        await documentTitle.fill(title);
        await fillSource(page, 'Long source line '.repeat(200));
        await expect(page.locator('.save-state')).toContainText('Saved on this device');
        await screenshot(page, `${browserType.name()}-${state}-source`);
        const more = page.getByRole('button', { name: 'More actions' });
        await more.click();
        await expect(more).toHaveAttribute('aria-expanded', 'true');
        await reachable(page.locator('#workspace-menu').getByRole('button', { name: 'Import .tex file', exact: true }), page);
        await reachable(page.locator('#workspace-menu').getByRole('button', { name: 'Copy private link', exact: true }), page);
        await touchTargets(page);
        await page.keyboard.press('Escape');
        await expect(page.getByRole('button', { name: 'Close menu' })).toBeHidden();
        await expect(more).toBeFocused();
        await more.click();
        await page.mouse.click(width / 2, 4);
        await expect(page.getByRole('button', { name: 'Close menu' })).toBeHidden();
        await (await menuAction(page, 'Documents')).click();
        await reachable(page.getByRole('button', { name: 'Delete current document' }), page);
        await page.getByRole('button', { name: 'Import .tex file', exact: true }).click();
        await page.locator('input[type=file]').setInputFiles({ name: 'bad.tex', mimeType: 'text/plain', buffer: Buffer.from([0, 255]) });
        await expect(page.locator('.error-banner')).toBeVisible();
        await page.getByRole('button', { name: 'Dismiss error' }).click();
        await page.getByRole('button', { name: 'Close documents' }).click();
        await expect(page.getByRole('button', { name: 'Delete current document' })).toBeHidden();
        await expect(more).toBeFocused();
        await page.getByRole('button', { name: 'Read', exact: true }).click();
        await (await menuAction(page, 'Help')).click();
        await reachable(page.getByRole('link', { name: /Compiler credits/ }), page);
        await page.keyboard.press('Escape');
        await (await menuAction(page, 'Sign in')).click();
        await page.getByRole('textbox', { name: 'Username' }).fill('mobile_review');
        await page.getByLabel('Password', { exact: true }).fill('review-password-only');
        await reachable(page.getByRole('dialog').getByRole('button', { name: 'Sign in', exact: true }), page);
        await page.getByRole('button', { name: 'New here? Create an account' }).click();
        await reachable(page.getByRole('button', { name: 'Create account', exact: true }), page);
        await screenshot(page, `${browserType.name()}-${state}-auth`);
        await page.getByRole('button', { name: 'Close sign in' }).focus();
        await page.keyboard.press('Escape');
        await expect(page.getByRole('dialog')).toHaveCount(0);
        await touchTargets(page);
        await page.getByRole('button', { name: 'Your projects', exact: true }).click();
        await expect(page.getByRole('list', { name: 'Projects' })).toContainText(title);
        await screenshot(page, `${browserType.name()}-${state}-projects`);
      } finally {
        await context.close();
        await browser.close();
      }
    });
  }
}

test('mobile real PDF, recompilation, error log, cancel and exports preserve content', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/#workspace');
  await editorReady(page);
  await fillSource(page, source);
  await page.getByRole('button', { name: 'Compile', exact: true }).click();
  await expect(page.locator('.preview-status')).toContainText('Compiled in your browser', { timeout: 60000 });
  const viewer = page.locator('.pdf-viewer[title="Compiled PDF"]');
  await expect(viewer).toBeVisible();
  await expect(page.locator('.pdf-viewer.pending')).toHaveCount(0);
  expect(await viewer.evaluate(element => ({ filter: getComputedStyle(element).filter, scheme: getComputedStyle(element).colorScheme }))).toEqual({ filter: 'none', scheme: 'light' });
  const exported = page.waitForEvent('download');
  await (await menuAction(page, 'Export PDF')).click();
  const pdf = await readFile(await (await exported).path());
  expect(pdf.subarray(0, 5).toString()).toBe('%PDF-');
  if (process.env.MOBILE_ARTIFACTS) await page.waitForTimeout(1500);
  await screenshot(page, 'chromium-portrait-real-pdf');
  await page.setViewportSize({ width: 844, height: 390 });
  await viewer.scrollIntoViewIfNeeded();
  await screenshot(page, 'chromium-landscape-real-pdf');
  await page.getByRole('button', { name: 'Edit', exact: true }).click();
  await fillSource(page, source + '\n% recompilation');
  await page.getByRole('textbox', { name: 'LaTeX source', exact: true }).press('Control+s');
  await expect(page.locator('.preview-status')).toContainText('Compiled in your browser', { timeout: 60000 });
  await page.getByRole('button', { name: 'Edit', exact: true }).click();
  await (await menuAction(page, 'Live preview', 'label')).check();
  await page.keyboard.press('Escape');
  await fillSource(page, String.raw`\documentclass{article}\begin{document}\undefinedmobilecommand\end{document}`);
  await page.getByRole('button', { name: 'Read', exact: true }).click();
  await expect(page.locator('.compile-log')).toContainText('Undefined control sequence', { timeout: 60000 });
  await reachable(page.locator('.compile-log summary'), page);
  await screenshot(page, 'chromium-landscape-error-log');
  await page.getByRole('button', { name: 'Edit', exact: true }).click();
  await (await menuAction(page, 'Live preview', 'label')).uncheck();
  await page.keyboard.press('Escape');
  await fillSource(page, String.raw`\documentclass{article}\begin{document}\loop\iftrue\repeat\end{document}`);
  await page.getByRole('button', { name: 'Compile', exact: true }).click();
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(page.locator('.preview-status')).toContainText('Compilation cancelled.');
});
