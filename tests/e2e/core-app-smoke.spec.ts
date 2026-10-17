import { expect, test } from '@playwright/test';

// The real app shell boots with the real core (wiring picks up src/editor/core/index.ts).
test('app shell boots with the real core', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/');
  await expect(page.locator('.md-editor')).toBeVisible();
  await page.locator('.md-editor').click();
  await page.keyboard.type('# Hi');
  await expect(page.locator('.md-editor .md-heading')).toHaveCount(1);
  expect(errors).toEqual([]);
});
