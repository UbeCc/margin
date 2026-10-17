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

test('table toolbar does not overlap the line above (#9)', async ({ page }) => {
  await open(page, 'line above the table\n\n|a|b|\n|-|-|\n|1|2|\n\nq\n');
  await cell(page, 1, 0).click();
  const tools = W(page, 'table').locator('.mb-table-tools');
  await expect(tools).toBeVisible();
  const t = (await tools.boundingBox())!;
  const p = (await page.locator('.md-block').first().locator('.md-content').boundingBox())!;
  const grid = (await W(page, 'table').locator('table').boundingBox())!;
  expect(t.y).toBeGreaterThanOrEqual(p.y + p.height - 0.5);
  expect(t.y + t.height).toBeLessThanOrEqual(grid.y + 0.5);
  // clicking the paragraph text right above the toolbar still reaches the paragraph
  await page.mouse.click(p.x + 5, p.y + p.height - 3);
  await page.keyboard.type('Z');
  await expect.poll(() => md(page)).toMatch(/^[^\n]*Z[^\n]*\n\n\|a\|b\|\n/);
});

test.describe('table cells', () => {
  const paste = (page: Page, text: string) =>
    page.evaluate((t) => {
      const dt = new DataTransfer();
      dt.setData('text/plain', t);
      document.activeElement!.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
    }, text);

  test('pasting TSV / CSV fills and grows the grid; plain multi-line text is flattened', async ({ page }) => {
    await open(page, 'p\n\n|a|b|\n|-|-|\n|1|2|\n\nq\n');
    await cell(page, 1, 1).click();
    await paste(page, 'x\ty\nz\tw\n');
    await expect.poll(() => md(page)).toBe('p\n\n| a   | b   |     |\n| --- | --- | --- |\n| 1   | x   | y   |\n|     | z   | w   |\n\nq\n');
    await expect(cell(page, 2, 2)).toBeFocused();
    await cell(page, 0, 0).click();
    await paste(page, 'k,v\n"a, b",c');
    await expect.poll(async () => (await md(page)).split('\n')[2]).toBe('| k    | v   |     |');
    await cell(page, 1, 0).click();
    await page.keyboard.press(lineEnd);
    await paste(page, 'one\ntwo');
    await expect.poll(async () => (await md(page)).split('\n')[4]).toContain('one two');
  });

  test('escaped pipes render as | (also inside code spans) and round-trip', async ({ page }) => {
    const src = '| `a\\|b` | c \\| d |\n|---|---|\n| x | y |\n';
    await open(page, `p\n\n${src}\nq\n`);
    await expect(cell(page, 0, 0).locator('code')).toHaveText('a|b');
    await expect(cell(page, 0, 1)).toHaveText('c | d');
    await cell(page, 1, 1).click();
    await page.keyboard.press(lineEnd);
    await page.keyboard.type('|z');
    await expect.poll(() => md(page)).toBe(`p\n\n${src.replace('| x | y |', '| x | y\\|z |')}\nq\n`);
    await cell(page, 0, 0).click();
    await expect(cell(page, 0, 0)).toHaveText('`a\\|b`'); // raw while editing
  });
});

test('math \\label renders; \\eqref follows the referenced \\tag (#7)', async ({ page }) => {
  await open(page, 'See $\\eqref{e}$ here.\n\n$$\nE = mc^2 \\tag{1} \\label{e}\n$$\n\n$$\nx \\label{plain}\n$$\n');
  await expect(W(page, 'math_block', 1).locator('.katex')).toBeVisible();
  await expect(W(page, 'math_block', 1).locator('.mb-error')).toHaveCount(0);
  await expect(page.locator('.md-paragraph .mb-inline-math, .md-block').first()).toContainText('(1)');
  await W(page, 'math_block', 0).click();
  await page.waitForTimeout(150);
  await page.keyboard.press(`${mod}+Home`);
  await page.keyboard.press('End');
  // change \tag{1} → \tag{7} through the editor
  for (let i = 0; i < ' \\label{e}'.length + 1; i++) await page.keyboard.press('ArrowLeft');
  await page.keyboard.press('Backspace');
  await page.keyboard.type('7');
  await expect.poll(() => md(page)).toContain('\\tag{7} \\label{e}');
  await expect(page.locator('.md-block').first()).toContainText('(7)');
  const html = await page.evaluate(() => window.__core.ed.renderHTML());
  expect(html).not.toContain('mb-math-error');
});
