import { expect, test } from '@playwright/test';
import { boot, editorValue, MOD, ROOT } from './app-helpers';

test.beforeEach(async ({ page }) => boot(page));

test('quick open fuzzy-finds files with highlights', async ({ page }) => {
  await page.keyboard.press(`${MOD}+p`);
  const palette = page.locator('.palette.quick-open');
  await expect(palette).toBeVisible();
  await page.keyboard.type('rdlst');
  const first = palette.locator('.palette-item').first();
  await expect(first).toHaveAttribute('data-id', `${ROOT}/Ideas/Reading list.md`);
  await expect(first.locator('mark').first()).toBeVisible();
  await page.keyboard.press('Enter');
  await expect(palette).toHaveCount(0);
  await expect.poll(() => editorValue(page)).toContain('# Reading list');
});

test('command palette runs commands', async ({ page }) => {
  await page.keyboard.press(`${MOD}+Shift+a`);
  await page.keyboard.type('toggle sidebar');
  await page.keyboard.press('Enter');
  await expect(page.locator('.app')).toHaveClass(/sidebar-hidden/);
  await page.keyboard.press(`${MOD}+Backslash`);
  await expect(page.locator('.app')).not.toHaveClass(/sidebar-hidden/);
});

test('outline lists headings and jumps on click', async ({ page }) => {
  await page.locator('.sidebar-tab[data-tab=outline]').click();
  const items = page.locator('.outline-item');
  await expect(items).toHaveCount(5);
  await expect(items.first()).toHaveText('Welcome to Margin');
  await items.filter({ hasText: 'Writing' }).click();
  const caret = await page.locator('.stub-editor').evaluate((el: HTMLTextAreaElement) => el.value.slice(el.selectionStart, el.selectionStart + 10));
  expect(caret).toBe('## Writing');
  await expect(items.filter({ hasText: 'Writing' })).toHaveClass(/active/);
});

test('keyboard shortcuts drive editor commands', async ({ page }) => {
  const ed = page.locator('.stub-editor');
  await ed.focus();
  await ed.evaluate((el: HTMLTextAreaElement) => el.setSelectionRange(el.value.indexOf('Margin is'), el.value.indexOf('Margin is')));
  await page.keyboard.press(`${MOD}+2`);
  await expect.poll(() => editorValue(page)).toContain('## Margin is a quiet place');
  await page.keyboard.press(`${MOD}+0`);
  await expect.poll(() => editorValue(page)).toContain('\nMargin is a quiet place');
  await page.keyboard.press('F8');
  await expect(page.locator('.app')).toHaveClass(/focus-mode/);
  await page.keyboard.press(`${MOD}+Slash`);
  await expect(page.locator('.source-toggle')).toHaveClass(/on/);
});

test('find bar finds, reports misses, replaces all', async ({ page }) => {
  await page.locator('.stub-editor').focus();
  await page.keyboard.press(`${MOD}+f`);
  const bar = page.locator('.findbar');
  await expect(bar).toBeVisible();
  await page.keyboard.type('Simplicity');
  await page.keyboard.press('Enter');
  const sel = await page.locator('.stub-editor').evaluate((el: HTMLTextAreaElement) => el.value.slice(el.selectionStart, el.selectionEnd));
  expect(sel).toBe('Simplicity');
  await bar.locator('.find-input').first().fill('zzz-nope');
  await page.keyboard.press('Enter');
  await expect(bar.locator('.find-status')).toHaveText('No results');

  await page.keyboard.press(`${MOD}+Alt+f`);
  await bar.locator('.find-input').first().fill('Margin');
  await bar.locator('.find-input').nth(1).fill('Marginalia');
  await bar.locator('.find-replace-all').click();
  await expect.poll(() => editorValue(page)).toContain('# Welcome to Marginalia');
  await page.keyboard.press('Escape');
  await expect(bar).toBeHidden();
});
