import { expect, test } from '@playwright/test';
import { boot, caretAtText, editorValue, MOD, ROOT } from './app-helpers';

const selectedText = (page: import('@playwright/test').Page) => page.evaluate(() => getSelection()!.toString());

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
  // Scrolls the heading to the top of the editor scroller (caret is not moved, like Typora).
  await expect
    .poll(() =>
      page.evaluate(() => {
        const hd = [...document.querySelectorAll('.md-block[data-type=heading]')].find((e) => e.textContent!.endsWith('Writing'))!;
        return Math.round(hd.getBoundingClientRect().top - document.querySelector('.editor-scroll')!.getBoundingClientRect().top);
      }),
    )
    .toBeLessThan(80);
  await expect(items.filter({ hasText: 'Writing' })).toHaveClass(/active/);
});

test('keyboard shortcuts drive editor commands', async ({ page }) => {
  await caretAtText(page, 'Margin is');
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
  await caretAtText(page, 'Margin is');
  await page.keyboard.press(`${MOD}+f`);
  const bar = page.locator('.findbar');
  await expect(bar).toBeVisible();
  await page.keyboard.type('Simplicity');
  await page.keyboard.press('Enter');
  await expect.poll(() => selectedText(page)).toBe('Simplicity');
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

test('native menu actions route through one dispatcher (desktop path)', async ({ page }) => {
  const menu = (a: string) => page.evaluate((x) => window.__MARGIN_WEB__!.triggerMenu(x as never), a);
  await caretAtText(page, 'Margin is');
  await menu('heading:3');
  await expect.poll(() => editorValue(page)).toContain('### Margin is a quiet place');
  await menu('toggleTypewriter');
  await expect(page.locator('.app')).toHaveClass(/typewriter-mode/);

  // Undo while typing in the find bar undoes the input, not the document.
  await menu('find');
  const input = page.locator('.findbar .find-input').first();
  await expect(input).toBeFocused();
  await page.keyboard.type('abc');
  await menu('undo');
  await expect(input).toHaveValue('');
  await expect.poll(() => editorValue(page)).toContain('### Margin is a quiet place');
});
