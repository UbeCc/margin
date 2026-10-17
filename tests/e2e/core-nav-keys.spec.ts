/**
 * Document-edge / line-start keys: #56 (doc end when the last block is a widget),
 * #57 (WebKit: doc/line start must land after a heading's hidden "# " marker).
 */
import { expect, test } from '@playwright/test';
import { open, md, docEnd, docStart, lineStart } from './core-shared';

test.describe('navigation keys (#56 #57)', () => {
  for (const [name, tail] of [
    ['math', '$$\nx\n$$\n'],
    ['code fence', '```js\nlet a;\n```\n'],
    ['table', '| a | b |\n| - | - |\n| c | d |\n'],
  ] as const) {
    test(`doc end moves into a trailing ${name} widget (#56)`, async ({ page }) => {
      await open(page, `# H\n\npara\n\n${tail}`);
      await page.locator('.md-editor h1, .md-editor .md-block').first().click();
      await page.keyboard.press(docEnd);
      await expect.poll(() => page.evaluate(() => !!document.activeElement?.closest('.mb-block'))).toBe(true);
      await page.keyboard.type('Z');
      const out = await md(page);
      expect(out.startsWith('# H\n\npara\n\n')).toBe(true);
      expect(out).toContain('Z');
    });
  }

  test('doc start lands after the heading marker (#57)', async ({ page }) => {
    await open(page, '# H\n\npara\n');
    await page.getByText('para').click();
    await page.keyboard.press(docStart);
    await page.keyboard.type('Z');
    expect(await md(page)).toBe('# ZH\n\npara\n');
  });

  test('line start on a heading lands after the marker (#57)', async ({ page }) => {
    await open(page, 'p\n\n## Head\n');
    await page.getByText('Head').click();
    await page.keyboard.press('End');
    await page.keyboard.press(lineStart);
    await page.keyboard.type('Z');
    expect(await md(page)).toBe('p\n\n## ZHead\n');
  });
});
