/**
 * Block widgets embedded in the real editing core (src/editor/core/dev.html).
 * Every test checks the document markdown the core serializes, not widget-local state.
 */
import { expect, test, Page } from '@playwright/test';
import { open, md, mod } from './core-shared';

const W = (page: Page, t: string, i = 0) => page.locator(`.md-widget[data-type="${t}"]`).nth(i);
const cell = (page: Page, r: number, c: number, i = 0) => W(page, 'table', i).locator(`.mb-cell[data-r="${r}"][data-c="${c}"]`);
const lineEnd = process.platform === 'darwin' ? 'Meta+ArrowRight' : 'End';

test.describe('code fence in the core', () => {
  test('typing a closing fence line inside the body keeps one block (#37)', async ({ page }) => {
    await open(page, 'a\n\n```js\nx\n```\n\nb\n');
    await W(page, 'code_fence').locator('.cm-content').click();
    await page.keyboard.press(`${mod}+End`);
    await page.keyboard.type('\n```\ny');
    await expect.poll(() => md(page)).toBe('a\n\n````js\nx\n```\ny\n````\n\nb\n');
    await expect(page.locator('.md-widget')).toHaveCount(1);
  });
});

test.describe('table in the core', () => {
  test('cell edit rewrites only the touched row (#6)', async ({ page }) => {
    const src = '| h1  | h2  |\n| --- | --- |\n| a   | b   |\n| c   | d   |\n';
    await open(page, `p\n\n${src}\nq\n`);
    await cell(page, 1, 0).click();
    await page.keyboard.press(lineEnd);
    await page.keyboard.type('XYZW');
    await expect.poll(() => md(page)).toBe(`p\n\n${src.replace('| a   | b   |', '| aXYZW | b   |')}\nq\n`);
    // Tab off the last cell adds a row; the other rows stay byte-identical
    await cell(page, 2, 1).click();
    await page.keyboard.press('Tab');
    await page.keyboard.type('n');
    await expect.poll(() => md(page)).toBe(`p\n\n${src.replace('| a   | b   |', '| aXYZW | b   |')}| n   |     |\n\nq\n`);
  });
});
