import { test, expect } from '@playwright/test';

const warningSource = String.raw`\documentclass{article}
\begin{document}
\PackageWarning{demo}{A synthetic warning: <script>alert(1)</script>\MessageBreak with continuation}
\typeout{<img src=x onerror=alert(1)>}
See section \ref{not-defined}.
\end{document}`;
const errorSource = String.raw`\documentclass{article}
\begin{document}
\undefinedmacro
\end{document}`;

async function expectReadableHighlight(locator) {
  const contrast = await locator.evaluate(element => {
    const style = getComputedStyle(element);
    const luminance = color => {
      const channels = color.match(/\d+/g).slice(0, 3).map(Number).map(value => {
        const channel = value / 255;
        return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
      });
      return channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722;
    };
    const foreground = luminance(style.color), background = luminance(style.backgroundColor);
    return (Math.max(foreground, background) + 0.05) / (Math.min(foreground, background) + 0.05);
  });
  expect(contrast).toBeGreaterThanOrEqual(4.5);
}

async function expectOriginalText(page, log) {
  const original = await page.evaluate(() => latex.log().text);
  expect(await log.textContent()).toBe(original);
  const selection = await log.evaluate(element => {
    const selection = window.getSelection();
    const select = node => {
      const range = document.createRange();
      range.selectNodeContents(node);
      selection.removeAllRanges();
      selection.addRange(range);
      return selection.toString();
    };
    const selected = select(element);
    // Compare with the original plain <pre>, including native trailing-newline handling.
    const plain = document.createElement('pre');
    plain.textContent = element.textContent;
    element.after(plain);
    const baseline = select(plain);
    plain.remove();
    selection.removeAllRanges();
    return { selected, baseline };
  });
  expect(selection.selected).toBe(selection.baseline);
}

for (const colorScheme of ['light', 'dark']) {
  for (const mobile of [false, true]) {
    test.describe(`${colorScheme} ${mobile ? 'mobile' : 'desktop'} compilation log`, () => {
      test.use({ colorScheme, viewport: mobile ? { width: 390, height: 844 } : { width: 1440, height: 1000 } });

      test('highlights real warnings/errors without changing selectable text or the last good PDF', async ({ page }) => {
        await page.goto('/');
        await page.evaluate(() => latex.ready());
        await page.evaluate(source => latex.create({ title: 'Synthetic log example', source }), warningSource);
        const successful = await page.evaluate(() => latex.compile());
        expect(successful.ok).toBe(true);
        const successfulPdf = await page.evaluate(() => latex.exportPdf());
        expect(successfulPdf.base64).toMatch(/^JVBERi/);
        await page.evaluate(() => latex.show('preview'));
        const details = page.locator('.compile-log');
        if (mobile) {
          const showControls = page.getByRole('button', { name: 'Show reading controls' });
          if (await showControls.isVisible()) await showControls.click();
          await page.getByRole('button', { name: 'More actions', exact: true }).click();
          await page.getByRole('button', { name: 'Compilation log', exact: true }).click();
        } else await details.locator('summary').click();
        const log = details.locator('pre');
        await expect(log).toBeVisible();
        await expect(log.locator('.log-warning').filter({ hasText: 'Package demo Warning:' })).toContainText('(demo)');
        await expect(log.locator('.log-warning').filter({ hasText: 'LaTeX Warning:' }).first()).toBeVisible();
        await expect(log.locator('.log-error')).toHaveCount(0);
        await expect(log).toContainText('<img src=x onerror=alert(1)>');
        await expect(log.locator('.log-warning').first()).toContainText('<script>alert(1)</script>');
        await expect(log.locator('img,script')).toHaveCount(0);
        await expectOriginalText(page, log);
        const warning = log.locator('.log-warning').first();
        await expect(warning).toHaveCSS('color', 'rgb(255, 224, 154)');
        await expect(warning).toHaveCSS('background-color', 'rgb(62, 53, 36)');
        await expect(warning).toHaveCSS('border-inline-start-style', 'dashed');
        await expectReadableHighlight(warning);
        await expect(log).toHaveCSS('white-space', 'pre-wrap');
        await expect(log).toHaveCSS('overflow-wrap', 'anywhere');

        await page.evaluate(source => latex.setSource(source), errorSource);
        const failed = await page.evaluate(() => latex.compile());
        expect(failed.ok).toBe(false);
        await expect(log.locator('.log-error').first()).toContainText('! Undefined control sequence.');
        await expect(log.locator('.log-error').first()).toContainText('l.3');
        await expect(log.locator('.log-error').first()).toHaveCSS('color', 'rgb(255, 180, 180)');
        await expect(log.locator('.log-error').first()).toHaveCSS('background-color', 'rgb(70, 43, 50)');
        await expect(log.locator('.log-error').first()).toHaveCSS('border-inline-start-style', 'solid');
        await expectReadableHighlight(log.locator('.log-error').first());
        await expectOriginalText(page, log);
        expect((await page.evaluate(() => latex.pdf())).bytes).toBeGreaterThan(0);
        expect((await page.evaluate(() => latex.exportPdf())).base64).toBe(successfulPdf.base64);
        expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(mobile ? 390 : 1440);
      });
    });
  }
}

test('read-only shared viewer uses the same safe diagnostic highlighting', async ({ page }) => {
  const id = 'a'.repeat(64);
  await page.route(`**/api/shares/${id}`, route => route.fulfill({
    json: { document: { title: 'Synthetic shared log', source: warningSource, updated_at: 1 } },
  }));
  await page.goto(`/share/${id}`);
  await expect(page.locator('.preview-status [role=status]')).toContainText('Compiled in your browser');
  await page.locator('.compile-log summary').click();
  const log = page.locator('.compile-log pre');
  await expect(log.locator('.log-warning').first()).toContainText('Package demo Warning:');
  await expect(log).toContainText('<img src=x onerror=alert(1)>');
  await expect(log.locator('img,script')).toHaveCount(0);
});
