/**
 * QA regressions driven through real keyboard input (both engines via the
 * project list). Issue numbers in titles.
 */
import { expect, test, type Page } from '@playwright/test';
import { open, md, mod } from './core-shared';

const find = (page: Page, q: string) => page.evaluate((q) => window.__core.ed.exec({ kind: 'find', query: q }), q);
const endOf = async (page: Page, q: string) => {
  await find(page, q);
  await page.keyboard.press('ArrowRight');
};
const startOf = async (page: Page, q: string) => {
  await find(page, q);
  await page.keyboard.press('ArrowLeft');
};
const paste = (page: Page, data: Record<string, string>) =>
  page.evaluate((data) => {
    const dt = new DataTransfer();
    for (const [k, v] of Object.entries(data)) dt.setData(k, v);
    document.querySelector('.md-editor')!.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
  }, data);

test.describe('core QA regressions', () => {
  test('type a whole document from empty (#49 #51 #58)', async ({ page }) => {
    await open(page, '', '&empty&blocks=0');
    await page.locator('.md-editor').click();
    const k = page.keyboard;
    for (const line of ['# Title', 'Para **b**.', '- one', 'two', '', '- [ ] task', 'next', '', '> quoted', '', 'end']) {
      if (line) await k.type(line);
      await k.press('Enter');
    }
    expect(await md(page)).toBe('# Title\n\nPara **b**.\n\n- one\n- two\n\n- [ ] task\n- [ ] next\n\n> quoted\n\nend\n\n\n');
    await expect(page.locator('.md-task-box')).toHaveCount(2);
    for (let i = 0; i < 40; i++) await k.press(`${mod}+z`);
    expect(await md(page)).toBe('');
  });

  test('Enter at the start of a heading keeps the heading (#58)', async ({ page }) => {
    await open(page, 'p\n\n# Head\n', '&blocks=0');
    await startOf(page, 'Head');
    await page.keyboard.press('Enter');
    await page.keyboard.type('x');
    expect(await md(page)).toBe('p\n\n\n# xHead\n');
    await expect(page.locator('.md-heading')).toHaveCount(1);
  });

  test('outdent inside a quote keeps the quote (#52)', async ({ page }) => {
    await open(page, '> - a\n> - b\n', '&blocks=0');
    await startOf(page, 'b');
    await page.keyboard.press('Shift+Tab');
    expect(await md(page)).toBe('> - a\n> b\n');
  });

  test('paste Google Docs HTML and markdown blocks mid-paragraph (#62)', async ({ page }) => {
    await open(page, 'AB\n', '&blocks=0');
    await startOf(page, 'B');
    await paste(page, {
      'text/html':
        '<b style="font-weight:normal;" id="docs-internal-guid-1"><p><span>One </span><span style="font-weight:700">bold</span></p><p><span>Two</span></p></b>',
      'text/plain': 'One bold\nTwo',
    });
    expect(await md(page)).toBe('A\n\nOne **bold**\n\nTwo\n\nB\n');
  });

  test('typing over a cross-block selection, then undo', async ({ page }) => {
    await open(page, 'alpha\n\nbeta\n\ngamma\n', '&blocks=0');
    await page.evaluate(() => {
      const ed = window.__core.ed;
      ed.exec({ kind: 'find', query: 'pha' });
      const s = getSelection()!;
      const [n, o] = [s.anchorNode!, s.anchorOffset];
      ed.exec({ kind: 'find', query: 'bet' });
      s.setBaseAndExtent(n, o, s.focusNode!, s.focusOffset);
    });
    await page.keyboard.type('X');
    expect(await md(page)).toBe('alXa\n\ngamma\n');
    await page.keyboard.press(`${mod}+z`);
    expect(await md(page)).toBe('alpha\n\nbeta\n\ngamma\n');
  });

  test('emoji: type, arrow over, backspace whole graphemes', async ({ page }) => {
    await open(page, 'ab\n', '&blocks=0');
    await startOf(page, 'b');
    await page.keyboard.type('😀');
    await page.keyboard.press('ArrowLeft');
    await page.keyboard.type('X');
    expect(await md(page)).toBe('aX😀b\n');
    await endOf(page, '😀');
    await page.keyboard.press('Backspace');
    expect(await md(page)).toBe('aXb\n');
  });

  test('typing in a 5k-line document stays fast (#33)', async ({ page }) => {
    await open(page, 'x\n', '&blocks=0');
    const doc = Array.from({ length: 1000 }, (_, i) => `## S${i}\n\nPara ${i} with **b**.\n\n- item\n`).join('\n');
    await page.evaluate((m) => window.__core.ed.setMarkdown(m), doc);
    await endOf(page, 'Para 500 ');
    const ms = await page.evaluate(() => {
      const root = document.querySelector('.md-editor')!;
      const t = performance.now();
      for (let i = 0; i < 20; i++) root.dispatchEvent(new InputEvent('beforeinput', { inputType: 'insertText', data: 'z', bubbles: true, cancelable: true }));
      return (performance.now() - t) / 20;
    });
    expect(await md(page)).toContain('Para 500 zzzzzzzzzzzzzzzzzzzzwith');
    expect(ms).toBeLessThan(25);
  });

  test('source mode keeps the caret both ways; undo after leaving it (#35)', async ({ page }) => {
    const big = Array.from({ length: 120 }, (_, i) => `## H${i}\n\npara ${i}\n`).join('\n');
    await open(page, 'x\n');
    await page.evaluate((m) => window.__core.ed.setMarkdown(m), big);
    await endOf(page, 'para 100');
    await page.evaluate(() => window.__core.ed.setSourceMode(true));
    await page.keyboard.type('X');
    expect(await md(page)).toContain('para 100X\n');
    await page.evaluate(() => window.__core.ed.setSourceMode(false));
    await page.keyboard.type('Y');
    expect(await md(page)).toContain('para 100XY\n');
    await page.keyboard.press(`${mod}+z`);
    await page.keyboard.press(`${mod}+z`);
    expect(await md(page)).toBe(big);
  });
});
