import { test, expect, chromium, webkit, devices } from '@playwright/test';
import { join } from 'node:path';

const profiles = [
  ['desktop', { viewport: { width: 1920, height: 1080 } }],
  ['laptop', { viewport: { width: 1366, height: 768 } }],
  ['iphone', devices['iPhone 13 Pro']],
];
const longTitle = 'A detailed research paper about browser typesetting and accessible document editing on every screen';

for (const browserType of [chromium, webkit]) {
  for (const [profile, options] of profiles) {
    test(`${browserType.name()} ${profile}: title fits its text within the toolbar`, async ({ baseURL }) => {
      const browser = await browserType.launch();
      const context = await browser.newContext({ ...options, baseURL });
      const page = await context.newPage();
      try {
        await page.goto('/#workspace');
        const input = page.getByRole('textbox', { name: 'Document title', exact: true });
        await expect(input).toBeEditable();
        await expect(input).toHaveAttribute('maxlength', '100');
        for (const [label, title] of [
          ['short', 'Notes'], ['long', longTitle], ['maximum', 'W'.repeat(100)],
          ['narrow', 'i'.repeat(30)], ['wide', 'W'.repeat(30)], ['empty', ''],
        ]) {
          await input.fill(title);
          await expect(input).toHaveValue(title);
          await expect.poll(() => input.evaluate(element => {
            const style = getComputedStyle(element);
            const canvas = document.createElement('canvas');
            const context = canvas.getContext('2d');
            context.font = style.font;
            const desired = Math.max(44, context.measureText(element.value + ' ').width +
              parseFloat(style.paddingLeft) + parseFloat(style.paddingRight));
            const box = element.getBoundingClientRect();
            const titleGroup = element.closest('.document-title');
            const group = titleGroup.getBoundingClientRect();
            const siblings = [...titleGroup.children].filter(sibling =>
              sibling !== element.parentElement && getComputedStyle(sibling).display !== 'none' &&
              sibling.getBoundingClientRect().top < box.bottom && sibling.getBoundingClientRect().bottom > box.top);
            const occupied = siblings.reduce((width, sibling) => width + sibling.getBoundingClientRect().width, 0) +
              siblings.length * parseFloat(getComputedStyle(titleGroup).columnGap);
            const actions = document.querySelector('.document-actions').getBoundingClientRect();
            const toolbar = element.closest('.document-toolbar').getBoundingClientRect();
            const sameRow = box.top < actions.bottom && actions.top < box.bottom;
            return {
              fitsText: box.width <= desired + 2,
              usesAvailableWidth: Math.abs(box.width - Math.min(desired, group.width - occupied)) <= 2,
              insideGroup: box.right <= group.right + 1,
              noOverlap: !sameRow || box.right < actions.left,
              controlsVisible: actions.right <= toolbar.right && actions.left >= toolbar.left,
              touchHeight: box.height >= 44,
              noPageOverflow: document.documentElement.scrollWidth === innerWidth,
              mobileFont: innerWidth > 1050 || parseFloat(style.fontSize) >= 16,
            };
          })).toEqual({
            fitsText: true, usesAvailableWidth: true, insideGroup: true, noOverlap: true,
            controlsVisible: true, touchHeight: true, noPageOverflow: true, mobileFont: true,
          });
          if (label === 'short') expect((await input.boundingBox()).width).toBeLessThan(100);
          if (label === 'long') expect((await input.boundingBox()).width).toBeGreaterThan(210);
          if (process.env.TITLE_ARTIFACTS && ['short', 'long'].includes(label)) {
            await input.blur();
            await page.screenshot({ path: join(process.env.TITLE_ARTIFACTS, `title-after-${browserType.name()}-${profile}-${label}.png`) });
          }
        }
        await input.blur();
        await expect(input).toHaveValue('Untitled paper');
        await input.fill('Notes');
        await expect.poll(async () => (await input.boundingBox()).width).toBeLessThan(100);
        await expect(input).toBeFocused();
        expect(await input.evaluate(element => getComputedStyle(element).outlineStyle)).not.toBe('none');
        await input.blur();
        await expect(page.locator('.save-state')).toContainText('Saved on this device');
        await page.reload();
        await expect(input).toHaveValue('Notes');
        expect((await input.boundingBox()).width).toBeLessThan(100);
      } finally {
        await context.close();
        await browser.close();
      }
    });
  }
}
