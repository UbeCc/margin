import { expect, test } from '@playwright/test';
import { boot, MOD } from './app-helpers';

test('pandoc export in the web build reports an error and never leaves a progress notice (#81)', async ({ page }) => {
  await boot(page);
  for (const label of ['export as word', 'export as latex', 'export as epub']) {
    await page.keyboard.press(`${MOD}+Shift+a`);
    await page.keyboard.type(label);
    await page.keyboard.press('Enter');
    await expect(page.locator('.toast[data-kind=error]').last()).toContainText('needs Pandoc');
  }
  await expect(page.locator('.toast', { hasText: 'Exporting' })).toHaveCount(0);
});

test('preferences: pandoc path is editable and persisted', async ({ page }) => {
  await boot(page);
  await page.keyboard.press(`${MOD}+Comma`);
  await page.locator('.preferences').locator('.pref-tab[data-section=export]').click();
  const input = page.locator('input[data-pref=pandocPath]');
  await expect(input).toHaveValue('');
  await input.fill('/opt/homebrew/bin/pandoc');
  await input.press('Enter');
  await input.blur();
  await page.locator('button', { hasText: 'Detect' }).click();
  await expect(page.locator('[data-pref-status=pandoc]')).toContainText('desktop app');
  await page.keyboard.press('Escape');
  await page.keyboard.press(`${MOD}+Comma`);
  await page.locator('.preferences').locator('.pref-tab[data-section=export]').click();
  await expect(page.locator('input[data-pref=pandocPath]')).toHaveValue('/opt/homebrew/bin/pandoc');
});
