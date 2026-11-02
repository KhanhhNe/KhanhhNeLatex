import { test, expect, devices, chromium, webkit } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { editorReady, sourceEditor } from './source-editor.js';
import { mobileAction } from './mobile-menu.js';

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
        const zoom = page.getByRole('group', { name: 'PDF zoom' });
        for (const name of ['Zoom out', 'Zoom in', 'Fit width']) {
          const button = zoom.getByRole('button', { name, exact: true });
          await expect(button).toBeInViewport();
          expect((await button.boundingBox()).height).toBeGreaterThanOrEqual(44);
        }
        await expect(page.getByRole('button', { name: 'Save to account' })).toBeHidden();
        await expect(page.getByRole('textbox', { name: 'Document title' })).toHaveAttribute('readonly', '');
        const viewport = await page.locator('.pdf-viewport').boundingBox();
        expect(viewport.height).toBeGreaterThan(height === 844 ? 400 : 100);
        expect(viewport.y + viewport.height).toBeLessThanOrEqual(height);
        expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(width);
        for (const name of ['Export .tex', 'Export PDF']) {
          const button = await mobileAction(page, name);
          await expect(button).toBeInViewport();
          const box = await button.boundingBox();
          expect(box.height).toBeGreaterThanOrEqual(44);
          const waiting = page.waitForEvent('download');
          await button.click();
          const bytes = await readFile(await (await waiting).path());
          expect(bytes.subarray(0, 5).toString()).toBe(name === 'Export PDF' ? '%PDF-' : '\\docu');
          await expect(page.getByRole('button', { name: 'More actions' })).toBeFocused();
        }
        await expect(await mobileAction(page, 'Open PDF', 'link')).toBeInViewport();
        const copyLink = await mobileAction(page, 'Copy private link');
        await expect(copyLink).toBeInViewport();
        if (browserType === chromium) {
          await context.grantPermissions(['clipboard-read', 'clipboard-write']);
          await copyLink.click();
          expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(page.url());
        } else {
          await page.evaluate(() => Object.defineProperty(navigator, 'clipboard', {
            configurable: true, value: { writeText: async text => { window.__copiedLink = text; } },
          }));
          await copyLink.click();
          expect(await page.evaluate(() => window.__copiedLink)).toBe(page.url());
          await page.evaluate(() => { delete navigator.clipboard; delete window.__copiedLink; });
        }
        await expect(page.locator('#workspace-menu [role="status"]')).toContainText('Private link copied to clipboard.');
        if (process.env.MOBILE_ARTIFACTS) await page.screenshot({
          path: join(process.env.MOBILE_ARTIFACTS, `after-${browserType.name()}-${orientation}-actions.png`),
        });
        await page.keyboard.press('Escape');
        await expect(page.locator('#workspace-menu')).not.toHaveAttribute('open', '');
        // A tap on the page hides the toolbar and zoom controls for reading; another tap restores them.
        const toolbar = page.locator('.document-toolbar');
        const tapCenter = async () => {
          const area = await page.locator('.pdf-viewport').boundingBox();
          await page.touchscreen.tap(area.x + area.width / 2, area.y + area.height / 2);
        };
        await tapCenter();
        await expect(page.locator('.workspace-view')).toHaveClass(/chrome-hidden/);
        const showControls = page.getByRole('button', { name: 'Show reading controls' });
        await expect(showControls).toBeVisible();
        expect((await showControls.boundingBox()).height).toBeGreaterThanOrEqual(44);
        if (process.env.MOBILE_ARTIFACTS) await page.screenshot({
          path: join(process.env.MOBILE_ARTIFACTS, `after-${browserType.name()}-${orientation}-show-controls.png`),
        });
        await showControls.click();
        await expect(page.locator('.workspace-view')).not.toHaveClass(/chrome-hidden/);
        await expect(showControls).toBeHidden();
        await tapCenter();
        await expect(page.locator('.workspace-view')).toHaveClass(/chrome-hidden/);
        await expect.poll(async () => (await toolbar.boundingBox()).y + (await toolbar.boundingBox()).height).toBeLessThanOrEqual(1);
        expect(await page.locator('.pdf-viewport').boundingBox()).toMatchObject({ y: viewport.y, height: viewport.height });
        await tapCenter();
        await expect(page.locator('.workspace-view')).not.toHaveClass(/chrome-hidden/);
        await page.getByRole('button', { name: 'More actions' }).focus();
        await expect(page.locator('.workspace-view')).not.toHaveClass(/chrome-hidden/);
        if (process.env.MOBILE_ARTIFACTS) await page.screenshot({
          path: join(process.env.MOBILE_ARTIFACTS, `after-${browserType.name()}-${orientation}.png`),
        });
        const pdf = await page.locator('.pdf-viewer').elementHandle();
        await page.getByRole('button', { name: 'Edit', exact: true }).click();
        await editorReady(page);
        await expect(page.getByRole('button', { name: 'Compile', exact: true })).toHaveText('Compile & read');
        await expect(await mobileAction(page, 'Save to account')).toBeVisible();
        await page.keyboard.press('Escape');
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

test('mobile account registration, cloud save status and sign-out are reachable', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/#workspace');
  await editorReady(page);
  await page.getByRole('button', { name: 'Edit', exact: true }).click();
  await page.getByRole('textbox', { name: 'Document title', exact: true }).fill('Mobile account workflow');
  await (await mobileAction(page, 'Sign in')).click();
  await page.getByRole('button', { name: 'New here? Create an account' }).click();
  const username = `mobile_${Date.now().toString(36)}`;
  await page.getByRole('textbox', { name: 'Username' }).fill(username);
  await page.getByLabel('Password', { exact: true }).fill('mobile-reachability-password');
  await page.getByRole('button', { name: 'Create account', exact: true }).click();
  await expect(page.locator('.auth-modal')).toHaveCount(0);
  const save = await mobileAction(page, 'Save to account');
  await expect(save).toBeVisible();
  await save.click();
  await expect(page.locator('.save-state')).toContainText('Saved to your account', { timeout: 15000 });
  await expect(await mobileAction(page, `Sign out ${username}`)).toBeVisible();
  await (await mobileAction(page, `Sign out ${username}`)).click();
  await expect(await mobileAction(page, 'Sign in')).toBeVisible();
});
