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

test.describe('html block in the core', () => {
  const VECTORS = [
    '<img src=x onerror="window.__pwned=1">',
    '<svg onload="window.__pwned=2"><circle r="1"/></svg>',
    '<details open ontoggle="window.__pwned=3">x</details>',
    '<math><mtext><table><mglyph><style><img src=x onerror="window.__pwned=4">',
    '<svg></p><style><a id="</style><img src=1 onerror=window.__pwned=5>">',
    '<noscript><p title="</noscript><img src=x onerror=window.__pwned=6>"></noscript>',
    '<a href="javascript:window.__pwned=7" id="jsl">link</a>',
    '<iframe srcdoc="<script>parent.__pwned=8</script>"></iframe>',
    '<video><source onerror="window.__pwned=9"></video>',
  ];
  test('preview and export neutralize XSS vectors (#8)', async ({ page }) => {
    const doc = 'top\n\n' + VECTORS.map((v) => `<div>\n${v}\n</div>\n`).join('\n') + '\nend\n';
    await open(page, doc);
    await expect(W(page, 'html_block', VECTORS.length - 1)).toBeVisible();
    const hrefs = await page.locator('.mb-html-block a').evaluateAll((as) => as.map((a) => a.getAttribute('href')));
    expect(hrefs.filter((h) => h && /javascript/i.test(h))).toEqual([]);
    await page.waitForTimeout(300);
    expect(await page.evaluate(() => (window as unknown as { __pwned?: number }).__pwned)).toBeUndefined();
    const html = await page.evaluate(() => window.__core.ed.renderHTML());
    expect(html).not.toMatch(/\son[a-z]+\s*=/i);
    expect(html).not.toMatch(/javascript:|<script|<iframe|<style/i);
    // the exported file itself must not execute anything either
    await page.setContent(html);
    await page.waitForTimeout(300);
    expect(await page.evaluate(() => (window as unknown as { __pwned?: number }).__pwned)).toBeUndefined();
  });
});

test.describe('table IME (#10)', () => {
  test('Enter/Tab/arrows during composition stay with the IME', async ({ page }) => {
    await open(page, 'p\n\n|a|b|\n|-|-|\n|1|2|\n\nq\n');
    await cell(page, 1, 0).click();
    await page.keyboard.press(lineEnd);
    // synthetic composing keydowns (what WebKit/Chromium send while an IME candidate window is open)
    for (const key of ['Enter', 'Tab', 'ArrowDown', 'ArrowRight', 'Escape', 'Backspace']) {
      await page.evaluate((k) => {
        const el = document.activeElement!;
        el.dispatchEvent(new KeyboardEvent('keydown', { key: k, keyCode: 229, isComposing: true, bubbles: true, cancelable: true }));
      }, key);
    }
    await expect(cell(page, 1, 0)).toBeFocused();
    expect(await md(page)).toBe('p\n\n|a|b|\n|-|-|\n|1|2|\n\nq\n');
  });

  test('real IME composition commits CJK text into the cell (Chromium CDP)', async ({ page, browserName }) => {
    test.skip(browserName !== 'chromium', 'CDP Input.imeSetComposition is Chromium-only');
    await open(page, 'p\n\n|a|b|\n|-|-|\n|1|2|\n\nq\n');
    await cell(page, 1, 1).click();
    await page.keyboard.press(lineEnd);
    const cdp = await page.context().newCDPSession(page);
    for (const s of ['n', 'ni', 'nih', 'niha', 'nihao']) await cdp.send('Input.imeSetComposition', { text: s, selectionStart: s.length, selectionEnd: s.length });
    await cdp.send('Input.insertText', { text: '你好' });
    await expect.poll(() => md(page)).toBe('p\n\n|a|b|\n|-|-|\n|1|2你好|\n\nq\n');
    await expect(cell(page, 1, 1)).toBeFocused();
    await page.keyboard.press('Tab'); // after commit, keys work again
    await expect(cell(page, 2, 0)).toBeFocused();
  });
});
