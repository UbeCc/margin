import { expect, test } from '@playwright/test';
import { boot, MOD, queueDialog, ROOT } from './app-helpers';

test('theme switching via preferences persists across reloads', async ({ page }) => {
  await page.emulateMedia({ colorScheme: 'light' });
  await boot(page);
  const root = page.locator('html');
  await expect(root).toHaveAttribute('data-theme', 'paper');

  await page.keyboard.press(`${MOD}+Comma`);
  const prefs = page.locator('.preferences');
  await expect(prefs).toBeVisible();
  await prefs.locator('select[data-pref=theme]').selectOption('github');
  await expect(root).toHaveAttribute('data-theme', 'github');
  const bg = await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--margin-bg').trim());
  expect(bg).toBe('#ffffff');

  await prefs.locator('select[data-pref=colorScheme]').selectOption('dark');
  await expect(root).toHaveAttribute('data-theme', 'night');
  await expect(root).toHaveAttribute('data-scheme', 'dark');

  await prefs.locator('input[data-pref=fontSize]').fill('19');
  await prefs.locator('input[data-pref=fontSize]').blur();
  await expect.poll(() => page.evaluate(() => getComputedStyle(document.querySelector('.editor-host')!).fontSize)).toBe('19px');
  await page.keyboard.press('Escape');
  await expect(prefs).toHaveCount(0);

  // settings save is debounced: wait until it is persisted
  await expect.poll(() => page.evaluate(() => localStorage.getItem('margin.web.settings.v1') ?? '')).toContain('"colorScheme":"dark"');
  await page.reload();
  await expect(page.locator('.app.ready')).toBeVisible();
  await expect(root).toHaveAttribute('data-theme', 'night');
});

test('system color scheme is followed', async ({ page }) => {
  await page.emulateMedia({ colorScheme: 'dark' });
  await boot(page);
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'night');
  await page.emulateMedia({ colorScheme: 'light' });
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'paper');
});

test('command palette theme entry and custom CSS', async ({ page }) => {
  await page.emulateMedia({ colorScheme: 'light' });
  await boot(page);
  await page.keyboard.press(`${MOD}+Shift+a`);
  await page.keyboard.type('theme github');
  await page.keyboard.press('Enter');
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'github');
  await page.keyboard.press(`${MOD}+Comma`);
  await page.locator('textarea[data-pref=customCss]').fill('.margin-doc { letter-spacing: 3px; }');
  await page.keyboard.press('Escape');
  await expect.poll(() => page.evaluate(() => getComputedStyle(document.querySelector('.editor-host')!).letterSpacing)).toBe('3px');
});

test('export HTML inlines the theme', async ({ page }) => {
  await boot(page);
  await queueDialog(page, `${ROOT}/Welcome.html`);
  await page.keyboard.press(`${MOD}+Shift+a`);
  await page.keyboard.type('export html');
  await page.keyboard.press('Enter');
  await expect(page.locator('.toast')).toContainText('Exported Welcome.html');
  const html = await page.evaluate(() => window.__MARGIN_WEB__!.exports[0].html);
  expect(html).toContain('<title>Welcome to Margin</title>');
  expect(html).toContain('--margin-accent');
  expect(html).toContain('<h1 id="h-0">Welcome to Margin</h1>');
});
