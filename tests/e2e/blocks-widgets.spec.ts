import { expect, test, Page } from '@playwright/test';

const DEV = '/src/editor/blocks/dev.html';

type B = { raw: Record<string, string>; events: string[]; sourceMd: string };
const blocks = (page: Page) => page.evaluate(() => (window as unknown as { __blocks: B }).__blocks);
const raw = async (page: Page, key: string) => (await blocks(page)).raw[key];
const events = async (page: Page) => (await blocks(page)).events;
const host = (page: Page, key: string) => page.locator(`[data-host="${key}"]`);
const mod = process.platform === 'darwin' ? 'Meta' : 'Control';

test.beforeEach(async ({ page }) => {
  page.on('pageerror', (e) => console.log('pageerror', e.message));
  await page.goto(DEV);
  await expect(page.locator('#status')).toHaveText('ready');
});

test.describe('code fence', () => {
  test('lazily creates CodeMirror, highlights, edits and round-trips', async ({ page }) => {
    const h = host(page, 'code_fence');
    await expect(h.locator('.cm-editor')).toBeVisible(); // near viewport → created
    await expect(h.locator('.tok-keyword').first()).toBeVisible();
    await h.locator('.cm-content').click();
    await page.keyboard.press(`${mod}+End`);
    await page.keyboard.type('\nhello();');
    expect(await raw(page, 'code_fence')).toBe(
      '```js\nfunction hello(name) {\n  // greet\n  return `Hello, ${name}!`;\n}\nhello();\n```\n',
    );
  });

  test('language box edits info string, copy button works', async ({ page, context }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    const h = host(page, 'code_fence_plain');
    await h.hover();
    const lang = h.locator('.mb-lang');
    await lang.fill('python');
    expect(await raw(page, 'code_fence_plain')).toBe('~~~~python\nplain text\n  indented\n~~~~\n\n');
    await h.hover();
    await h.locator('.mb-copy').click();
    await expect(h.locator('.mb-copy')).toHaveText('Copied');
  });

  test('arrow keys exit at edges; backspace in empty removes', async ({ page }) => {
    const h = host(page, 'code_fence');
    await h.locator('.cm-content').click();
    await page.keyboard.press(`${mod}+Home`);
    await page.keyboard.press('ArrowUp');
    expect(await events(page)).toContain('code_fence:exit-up');
    await expect(page.locator('[data-para="code_fence-before"]')).toBeFocused();
    // enter from below with ArrowUp → focus('end'), then ArrowDown exits down
    await page.locator('[data-para="code_fence-after"]').focus();
    await page.keyboard.press('ArrowUp');
    await page.keyboard.press('ArrowDown');
    expect(await events(page)).toContain('code_fence:exit-down');
    // clear and backspace
    await h.locator('.cm-content').click();
    await page.keyboard.press(`${mod}+a`);
    await page.keyboard.press('Backspace');
    expect(await raw(page, 'code_fence')).toBe('```js\n```\n');
    await page.keyboard.press('Backspace');
    expect(await events(page)).toContain('code_fence:remove');
  });

  test('update(raw) keeps the caret', async ({ page }) => {
    const h = host(page, 'code_fence');
    await h.locator('.cm-content').click();
    await page.keyboard.press(`${mod}+Home`);
    await page.keyboard.press('End'); // end of line 1
    await page.evaluate(() => {
      const b = (window as any).__blocks;
      b.instances.code_fence.update(b.raw.code_fence.replace('// greet', '// greeting!'));
    });
    await page.keyboard.type('X');
    const r = await raw(page, 'code_fence');
    expect(r).toContain('function hello(name) {X\n');
    expect(r).toContain('// greeting!');
  });
});

test.describe('math', () => {
  test('renders KaTeX, edits source, shows errors', async ({ page }) => {
    const h = host(page, 'math_block');
    await expect(h.locator('.mb-preview .katex-display')).toBeVisible();
    await expect(h.locator('.mb-panel')).toBeHidden();
    await h.locator('.mb-preview').click();
    await expect(h.locator('.mb-panel .cm-editor')).toBeVisible();
    await page.keyboard.press(`${mod}+a`);
    await page.keyboard.type('\\frac{1');
    await expect(h.locator('.mb-error')).toBeVisible();
    expect(await raw(page, 'math_block')).toBe('$$\n\\frac{1\n$$\n');
    await page.keyboard.type('}{2}');
    await expect(h.locator('.mb-error')).toHaveCount(0);
    await expect(h.locator('.mb-preview .katex')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(h.locator('.mb-panel')).toBeHidden();
    expect(await events(page)).toContain('math_block:exit-down');
  });

  test('inline math renders and shows errors', async ({ page }) => {
    await expect(page.locator('[data-imath=ok] .katex')).toBeVisible();
    await expect(page.locator('[data-imath=bad]')).toHaveClass(/mb-math-error/);
  });
});

test.describe('diagram', () => {
  test('mermaid renders SVG, errors are shown, sequence syntax translated', async ({ page }) => {
    const h = host(page, 'diagram');
    await expect(h.locator('.mb-diagram-svg svg')).toBeVisible({ timeout: 15000 });
    await expect(host(page, 'diagram_seq').locator('.mb-diagram-svg svg')).toBeVisible({ timeout: 15000 });
    await h.locator('.mb-preview').click();
    await page.keyboard.press(`${mod}+a`);
    await page.keyboard.type('graph TD\n  A -->');
    await expect(h.locator('.mb-error')).toBeVisible({ timeout: 10000 });
    await page.keyboard.type(' B');
    await expect(h.locator('.mb-error')).toHaveCount(0, { timeout: 10000 });
    expect(await raw(page, 'diagram')).toBe('```mermaid\ngraph TD\n  A --> B\n```\n');
  });

  test('theme switch re-renders dark', async ({ page }) => {
    const h = host(page, 'diagram');
    await expect(h.locator('.mb-diagram-svg svg')).toBeVisible({ timeout: 15000 });
    await page.click('#theme-toggle');
    await expect(h.locator('.mb-block')).toHaveAttribute('data-scheme', 'dark');
    await expect(h.locator('.mb-diagram-svg svg')).toBeVisible({ timeout: 15000 });
  });
});

test.describe('table', () => {
  test('cell editing, Tab navigation and serialization', async ({ page }) => {
    const h = host(page, 'table');
    const cell = (r: number, c: number) => h.locator(`.mb-cell[data-r="${r}"][data-c="${c}"]`);
    await expect(cell(1, 2).locator('strong')).toHaveText('fresh');
    await cell(1, 0).click();
    await page.keyboard.press(process.platform === 'darwin' ? 'Meta+ArrowRight' : 'End');
    await page.keyboard.type('s');
    await page.keyboard.press('Tab');
    await expect(cell(1, 1)).toBeFocused();
    await page.keyboard.press('Shift+Tab');
    await expect(cell(1, 0)).toBeFocused();
    expect(await raw(page, 'table')).toBe(
      ['| Name   | Qty | Note          |', '| :----- | --: | ------------- |', '| apples |   3 | **fresh**     |', '| pear   |  10 | `x` and $a^2$ |'].join('\n') + '\n',
    );
  });

  test('Tab at last cell adds a row; Enter moves down; toolbar ops', async ({ page }) => {
    const h = host(page, 'table');
    const cell = (r: number, c: number) => h.locator(`.mb-cell[data-r="${r}"][data-c="${c}"]`);
    await cell(2, 2).click();
    await page.keyboard.press('Tab');
    await expect(cell(3, 0)).toBeFocused();
    await page.keyboard.type('kiwi');
    expect((await raw(page, 'table')).split('\n')[4]).toMatch(/^\| kiwi\s+\|\s+\|\s+\|$/);
    await page.keyboard.press('ArrowUp');
    await expect(cell(2, 0)).toBeFocused();
    // alignment: center column 0
    await h.locator('.mb-align[data-align="center"]').click();
    expect((await raw(page, 'table')).split('\n')[1]).toMatch(/^\| :-+: \|/);
    // add column right of col 0
    await h.locator('.mb-col-right').click();
    expect((await raw(page, 'table')).split('\n')[0].split('|').length).toBe(6);
    // delete it again
    await h.locator('.mb-col-del').click();
    expect((await raw(page, 'table')).split('\n')[0].split('|').length).toBe(5);
    // delete row
    await cell(3, 0).click();
    await h.locator('.mb-row-del').click();
    expect((await raw(page, 'table')).trim().split('\n').length).toBe(4);
  });

  test('arrow exit from header and last row', async ({ page }) => {
    const h = host(page, 'table');
    await h.locator('.mb-cell[data-r="0"][data-c="1"]').click();
    await page.keyboard.press('ArrowUp');
    expect(await events(page)).toContain('table:exit-up');
    await h.locator('.mb-cell[data-r="2"][data-c="1"]').click();
    await page.keyboard.press('ArrowDown');
    expect(await events(page)).toContain('table:exit-down');
  });
});

test.describe('html, front matter, toc', () => {
  test('html block is sanitized and editable', async ({ page }) => {
    const h = host(page, 'html_block');
    await expect(h.locator('.mb-preview b')).toHaveText('Bold HTML');
    await expect(h.locator('.mb-preview script')).toHaveCount(0);
    expect(await page.evaluate(() => (window as any).__pwned)).toBeUndefined();
    await h.locator('.mb-preview').click();
    await page.keyboard.press(`${mod}+a`);
    // insertText bypasses the editor's tag auto-closing, which keystroke typing races with.
    await page.keyboard.insertText('<p>new</p>');
    // The preview re-renders on every keystroke, so wait for the final source first.
    await expect.poll(() => raw(page, 'html_block')).toBe('<p>new</p>\n');
    await expect(h.locator('.mb-preview p', { hasText: 'new' })).toHaveCount(1);
    await expect(h.locator('.mb-preview p:empty')).toHaveCount(0);
  });

  test('front matter collapsed box and yaml editing', async ({ page }) => {
    const h = host(page, 'front_matter');
    await expect(h.locator('.mb-fm-keys')).toHaveText('title · tags · date');
    await h.locator('.mb-preview').click();
    await expect(h.locator('.mb-preview')).toBeHidden();
    await page.keyboard.press(`${mod}+End`);
    await page.keyboard.type('\ndraft: true');
    expect(await raw(page, 'front_matter')).toBe('---\ntitle: Margin\ntags: [editor, markdown]\ndate: 2026-10-17\ndraft: true\n---\n');
    await page.locator('[data-para="front_matter-after"]').click();
    await expect(h.locator('.mb-fm-keys')).toHaveText('title · tags · date · draft');
  });

  test('toc lists headings and scrolls', async ({ page }) => {
    const h = host(page, 'toc');
    await expect(h.locator('a')).toHaveText(['Introduction', 'Usage', 'Details']);
    await h.locator('a', { hasText: 'Usage' }).click();
    expect(await events(page)).toContain('toc:scroll-h-usage');
    // live update
    await page.evaluate(() => (window as any).__blocks.headings.push({ id: 'h-new', level: 2, text: 'Added' }));
    await expect(h.locator('a')).toHaveCount(4, { timeout: 3000 });
  });
});

test('source mode edits, find/replace, theme', async ({ page }) => {
  const sh = page.locator('#source-host');
  await expect(sh.locator('.cm-editor')).toBeVisible();
  await expect(sh.locator('.tok-heading').first()).toBeVisible();
  await sh.locator('.cm-content').click();
  await page.keyboard.press(`${mod}+End`);
  await page.keyboard.type('- item three');
  expect((await blocks(page)).sourceMd.endsWith('- item two\n- item three')).toBe(true);
  const replaced = await page.evaluate(() => (window as any).__blocks.source.replace('item', 'entry', { all: true }));
  expect(replaced).toBe(true);
  expect((await blocks(page)).sourceMd).toContain('- entry two');
  await page.click('#theme-toggle');
  await expect(sh.locator('.mb-source')).toHaveAttribute('data-scheme', 'dark');
});

test('renderHTML exports static HTML for all widgets', async ({ page }) => {
  await expect(host(page, 'diagram').locator('.mb-diagram-svg svg')).toBeVisible({ timeout: 15000 });
  await page.click('#export');
  const out = page.locator('#export-out');
  await expect(out.locator('pre.md-fences[lang="js"] .tok-keyword').first()).toBeVisible();
  await expect(out.locator('.md-math-block .katex')).toBeVisible();
  await expect(out.locator('.md-diagram svg').first()).toBeVisible();
  await expect(out.locator('table th')).toHaveCount(3);
  await expect(out.locator('.md-toc a')).toHaveCount(3);
});
