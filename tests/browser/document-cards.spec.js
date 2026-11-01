import { test, expect, chromium, webkit, devices } from '@playwright/test';
import { join } from 'node:path';
import { editorReady } from './source-editor.js';

const longTitle = 'Research notes on typography and accessible document navigation with a very long descriptive title';

test('an unavailable last-edited date does not prevent opening the workspace', async ({ page }) => {
  await page.route('**/api/me', route => route.fulfill({ json: { user: { id: 'owner', username: 'writer' } } }));
  await page.route('**/api/documents', route => route.fulfill({
    json: { documents: [{ id: 'undated', title: 'Undated account document' }] },
  }));
  await page.goto('/#workspace');
  await editorReady(page);
  const card = page.locator('.document-row').filter({ hasText: 'Undated account document' });
  await expect(card).toContainText('Date unavailable');
  await expect(card.locator('time')).not.toHaveAttribute('datetime');
});

for (const [profile, options] of [
  ['desktop', { viewport: { width: 1440, height: 1000 } }],
  ['iphone-chromium', devices['iPhone 13 Pro']],
  ['iphone-webkit', devices['iPhone 13 Pro']],
]) {
  test.describe(profile, () => {
    test('document titles wrap across single-document cards with metadata inside', async ({ baseURL }) => {
      const browserType = profile === 'iphone-webkit' ? webkit : chromium;
      const browser = await browserType.launch();
      const context = await browser.newContext({ ...options, baseURL });
      const page = await context.newPage();
      try {
      const shared = new Map();
      let accountOpens = 0;
      await page.route('**/api/me', route => route.fulfill({ json: { user: { id: 'owner', username: 'writer' } } }));
      await page.route('**/api/documents', route => {
        return route.fulfill({ json: { documents: [...shared.values()] } });
      });
      await page.route('**/api/documents/sync', route => {
        const posted = route.request().postDataJSON();
        const document = { ...posted, id: `card-${posted.code}`, revision: 1, updated_at: Date.now() - 60000 };
        shared.set(document.id, document);
        return route.fulfill({ json: { document } });
      });
      await page.route('**/api/documents/card-*', route => {
        accountOpens++;
        return route.fulfill({ json: { document: shared.get(route.request().url().split('/').at(-1)) } });
      });
      await page.goto('/#workspace');
      await editorReady(page);
      await page.getByRole('textbox', { name: 'Document title', exact: true }).fill(longTitle);
      await page.getByRole('button', { name: 'Save to account', exact: true }).click();
      await expect(page.locator('.save-state')).toContainText('Saved to your account');
      const mobile = profile !== 'desktop';
      const openDrawer = async () => {
        if (mobile && !(await page.locator('#document-sidebar').isVisible())) {
          await page.getByRole('button', { name: 'Toggle documents' }).click();
        }
      };
      await openDrawer();
      await page.locator('.sidebar .new-document').click();
      await editorReady(page);
      await page.getByRole('textbox', { name: 'Document title', exact: true }).fill('Short notes');
      await expect(page.locator('.save-state')).toContainText('Saved to your account');
      await openDrawer();

      const card = page.locator('.document-row').filter({ hasText: longTitle });
      const select = card.locator('.document-item');
      const title = card.locator('.document-name');
      const details = card.locator('.document-details');
      await expect(card.getByRole('button', { name: /Open account version/ })).toHaveCount(0);
      await expect(select).toHaveAccessibleName(longTitle);
      await expect(card.getByRole('img', { name: 'Available on this device and in your account' })).toBeVisible();
      await expect(card.locator('time')).toHaveAttribute('datetime', /T/);
      expect(await card.locator('button button').count()).toBe(0);

      for (const size of mobile ? ['portrait'] : ['desktop', 'narrow']) {
        if (size === 'narrow') {
          await page.getByRole('separator', { name: 'Document sidebar width', exact: true }).focus();
          await page.keyboard.press('Home');
        }
        const boxes = await Promise.all([card, title, details].map(locator => locator.boundingBox()));
        const [cardBox, titleBox, detailsBox] = boxes;
        expect(titleBox.width).toBeCloseTo(cardBox.width - (mobile ? 20 : 16), 0);
        expect(titleBox.height).toBeGreaterThan(30);
        expect(detailsBox.y).toBeGreaterThanOrEqual(titleBox.y + titleBox.height);
        expect(detailsBox.x + detailsBox.width).toBeLessThanOrEqual(cardBox.x + cardBox.width);
        expect(detailsBox.y + detailsBox.height).toBeLessThanOrEqual(cardBox.y + cardBox.height);
        expect(await title.evaluate(element => element.scrollWidth <= element.clientWidth
          && element.scrollHeight <= element.clientHeight)).toBe(true);
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
        if (process.env.CARD_ARTIFACTS) {
          await page.screenshot({ path: join(process.env.CARD_ARTIFACTS, `cards-${profile}-${size}-after.png`) });
        }
      }

      // The date is inside the card-wide selection target, not an extra button.
      const date = await card.locator('time').boundingBox();
      await page.mouse.click(date.x + date.width / 2, date.y + date.height / 2);
      await expect(page.getByRole('textbox', { name: 'Document title', exact: true })).toHaveValue(longTitle);
      expect(accountOpens).toBe(1);
      await openDrawer();
      await expect(select).toHaveAttribute('aria-pressed', 'true');
      await expect(card).toHaveClass(/selected/);
      await select.focus();
      await page.keyboard.press('Tab');
      await page.keyboard.press('Shift+Tab');
      await expect(select).toBeFocused();
      expect(await select.evaluate(element => getComputedStyle(element, '::after').outlineStyle)).toBe('solid');
      await openDrawer();
      const short = page.locator('.document-item').filter({ hasText: 'Short notes' });
      await short.focus();
      await page.keyboard.press('Enter');
      await expect(page.getByRole('textbox', { name: 'Document title', exact: true })).toHaveValue('Short notes');
      await editorReady(page);
      await page.getByRole('textbox', { name: 'Document title', exact: true }).fill('X'.repeat(100));
      await openDrawer();
      const unbroken = page.locator('.document-name').filter({ hasText: 'X'.repeat(100) });
      await expect(unbroken).toBeVisible();
      expect(await unbroken.evaluate(element => element.scrollWidth <= element.clientWidth
        && element.scrollHeight <= element.clientHeight)).toBe(true);
      } finally {
        await browser.close();
      }
    });
  });
}
