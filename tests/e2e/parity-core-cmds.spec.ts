/**
 * Parity epic #93 — Paragraph & Format menu commands. One test per surface
 * (titles carry the surface id for the parity ledger). Commands are driven
 * the way the native menu delivers them (`App.run(menuAction)`), through the
 * command palette, or through their keyboard shortcut.
 */
import { expect, test, type Page } from '@playwright/test';
import { boot, caretAtText, editorValue, MOD } from './app-helpers';

test.beforeEach(async ({ page }) => boot(page));

async function load(page: Page, md: string): Promise<void> {
  await page.evaluate((m) => window.__margin!.editor.setMarkdown(m), md);
  await expect.poll(() => editorValue(page)).toBe(md);
}

/** Dispatch a MenuAction exactly like a native menu click (returns whether it applied). */
const menu = (page: Page, id: string): Promise<boolean> =>
  page.evaluate((a) => window.__margin!.run(a as Parameters<NonNullable<typeof window.__margin>['run']>[0]), id);

async function palette(page: Page, label: string): Promise<void> {
  await page.keyboard.press(`${MOD}+Shift+a`);
  await page.keyboard.type(label);
  await expect(page.locator('.palette-item').first()).toContainText(label);
  await page.keyboard.press('Enter');
}

/** Select the first occurrence of `text` (inside one text node) in the editor. */
async function select(page: Page, text: string): Promise<void> {
  await page.evaluate((t) => {
    const root = document.querySelector('.md-editor') as HTMLElement;
    const w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    for (let n = w.nextNode(); n; n = w.nextNode()) {
      const i = n.textContent!.indexOf(t);
      if (i < 0) continue;
      root.focus();
      getSelection()!.setBaseAndExtent(n, i, n, i + t.length);
      document.dispatchEvent(new Event('selectionchange'));
      return;
    }
    throw new Error(`text not found: ${t}`);
  }, text);
}

test('menu.para.heading-level: Paragraph › Increase / Decrease Heading Level', async ({ page }) => {
  await load(page, '# Title\n\nbody\n');
  await caretAtText(page, 'body', 2);
  expect(await menu(page, 'para:headingUp')).toBe(true);
  await expect.poll(() => editorValue(page)).toBe('# Title\n\n###### body\n');
  await menu(page, 'para:headingUp');
  await expect.poll(() => editorValue(page)).toBe('# Title\n\n##### body\n');
  await palette(page, 'Decrease Heading Level');
  await expect.poll(() => editorValue(page)).toBe('# Title\n\n###### body\n');
  await menu(page, 'para:headingDown');
  await expect.poll(() => editorValue(page)).toBe('# Title\n\nbody\n');
  // edges: a paragraph cannot go lower, an H1 cannot go higher
  expect(await menu(page, 'para:headingDown')).toBe(false);
  await caretAtText(page, 'Title', 1);
  expect(await menu(page, 'para:headingUp')).toBe(false);
  await menu(page, 'para:headingDown');
  await expect.poll(() => editorValue(page)).toBe('## Title\n\nbody\n');
  await page.keyboard.press(`${MOD}+z`);
  await expect.poll(() => editorValue(page)).toBe('# Title\n\nbody\n');
});

test('menu.para.insert-paragraph: Paragraph › Insert Paragraph Before / After', async ({ page }) => {
  await load(page, '# A\n\n```js\nx\n```\n\nB\n');
  await caretAtText(page, 'B', 0);
  expect(await menu(page, 'para:insertBefore')).toBe(true);
  await page.keyboard.type('before');
  await expect.poll(() => editorValue(page)).toBe('# A\n\n```js\nx\n```\n\nbefore\n\nB\n');
  await caretAtText(page, 'A', 1);
  await palette(page, 'Insert Paragraph After');
  await page.keyboard.type('after');
  await expect.poll(() => editorValue(page)).toBe('# A\n\nafter\n\n```js\nx\n```\n\nbefore\n\nB\n');
  // inside a list the new paragraph is a sibling item
  await load(page, '- one\n- two\n');
  await caretAtText(page, 'two', 3);
  await menu(page, 'para:insertAfter');
  await page.keyboard.type('three');
  await expect.poll(() => editorValue(page)).toBe('- one\n- two\n- three\n');
  await page.keyboard.press(`${MOD}+z`);
  await page.keyboard.press(`${MOD}+z`);
  await expect.poll(() => editorValue(page)).toBe('- one\n- two\n');
});

test('menu.format.underline: Format › Underline (<u>)', async ({ page }) => {
  await load(page, 'a word here\n');
  await select(page, 'word');
  await page.keyboard.press(`${MOD}+u`);
  await expect.poll(() => editorValue(page)).toBe('a <u>word</u> here\n');
  await expect(page.locator('.md-u')).toContainText('word');
  await expect(page.locator('.md-u')).toHaveCSS('text-decoration-line', 'underline');
  // toggles back off on the same selection
  await page.keyboard.press(`${MOD}+u`);
  await expect.poll(() => editorValue(page)).toBe('a word here\n');
  await select(page, 'here');
  await palette(page, 'Underline');
  await expect.poll(() => editorValue(page)).toBe('a word <u>here</u>\n');
  const html = await page.evaluate(() => window.__margin!.editor.renderHTML());
  expect(html).toContain('<u>here</u>');
});

test('menu.format.inline-math: Format › Inline Math (toggle $…$)', async ({ page }) => {
  await load(page, 'Energy E=mc^2 holds\n');
  await select(page, 'E=mc^2');
  await page.keyboard.press(`${MOD}+Shift+m`);
  await expect.poll(() => editorValue(page)).toBe('Energy $E=mc^2$ holds\n');
  await expect(page.locator('.md-math')).toHaveCount(1);
  expect(await menu(page, 'mark:math')).toBe(true);
  await expect.poll(() => editorValue(page)).toBe('Energy E=mc^2 holds\n');
  // collapsed caret: empty $|$ pair, typing fills it
  await caretAtText(page, 'holds', 5);
  await menu(page, 'mark:math');
  await page.keyboard.type('x');
  await expect.poll(() => editorValue(page)).toBe('Energy E=mc^2 holds$x$\n');
});

test('menu.format.clear: Format › Clear Format', async ({ page }) => {
  await load(page, '**bold** and *em* and <u>u</u> x<sup>2</sup>\n\nkeep **this**\n');
  await caretAtText(page, 'and', 1);
  await palette(page, 'Clear Format');
  await expect.poll(() => editorValue(page)).toBe('bold and em and u x2\n\nkeep **this**\n');
  await page.keyboard.press(`${MOD}+z`);
  await expect.poll(() => editorValue(page)).toBe('**bold** and *em* and <u>u</u> x<sup>2</sup>\n\nkeep **this**\n');
  // a partial selection clears only the styles it touches
  await select(page, 'bol');
  expect(await menu(page, 'clearFormat')).toBe(true);
  await expect.poll(() => editorValue(page)).toBe('bold and *em* and <u>u</u> x<sup>2</sup>\n\nkeep **this**\n');
  // nothing to clear → no change
  await load(page, 'plain text\n');
  await caretAtText(page, 'plain', 2);
  expect(await menu(page, 'clearFormat')).toBe(false);
  expect(await editorValue(page)).toBe('plain text\n');
});

test('menu.para.html-block: Paragraph › HTML Block (insert)', async ({ page }) => {
  await load(page, 'para\n');
  await caretAtText(page, 'para', 4);
  await palette(page, 'HTML Block');
  await expect.poll(() => editorValue(page)).toBe('para\n\n<div>\n</div>');
  await expect(page.locator('.md-block[data-type=html_block]')).toHaveCount(1);
  await page.keyboard.press(`${MOD}+z`);
  await expect.poll(() => editorValue(page)).toBe('para\n');
});

test('menu.para.task-status: Paragraph › Task Status: toggle / mark complete / incomplete', async ({ page }) => {
  await load(page, '- [ ] a\n- [x] b\n- c\n');
  await caretAtText(page, 'a', 1);
  expect(await menu(page, 'task:toggle')).toBe(true);
  await expect.poll(() => editorValue(page)).toBe('- [x] a\n- [x] b\n- c\n');
  await palette(page, 'Mark Task as Incomplete');
  await expect.poll(() => editorValue(page)).toBe('- [ ] a\n- [x] b\n- c\n');
  await page.evaluate(() => {
    const t = [...document.querySelectorAll('.md-editor .md-content')].map((e) => e.firstChild!);
    getSelection()!.setBaseAndExtent(t[0], 0, t[1], 1);
    document.dispatchEvent(new Event('selectionchange'));
  });
  await menu(page, 'task:complete');
  await expect.poll(() => editorValue(page)).toBe('- [x] a\n- [x] b\n- c\n');
  await expect(page.locator('.md-task-box')).toHaveCount(2);
  // not a task item → command does not apply
  await caretAtText(page, 'c', 1);
  expect(await menu(page, 'task:toggle')).toBe(false);
  expect(await editorValue(page)).toBe('- [x] a\n- [x] b\n- c\n');
});

test('menu.para.link-reference: Paragraph › Link Reference (insert [id]: url definition)', async ({ page }) => {
  await load(page, 'See [the docs][ref].\n');
  await caretAtText(page, 'See', 0);
  await palette(page, 'Link Reference');
  await page.keyboard.type('ref');
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+ArrowRight' : 'End');
  await page.keyboard.type('https://example.com');
  await expect.poll(() => editorValue(page)).toBe('See [the docs][ref].\n\n[ref]: https://example.com');
  // the reference link now resolves
  await expect(page.locator('.md-link').first()).toHaveAttribute('data-href', 'https://example.com');
});

test('menu.para.footnotes: Paragraph › Footnotes (insert, hover preview, jump)', async ({ page }) => {
  await load(page, 'Text here.\n');
  await caretAtText(page, 'Text', 4);
  expect(await menu(page, 'block:footnote')).toBe(true);
  await page.keyboard.type('Note body');
  await expect.poll(() => editorValue(page)).toBe('Text[^1] here.\n\n[^1]: Note body');
  const ref = page.locator('.md-fnref').first();
  await ref.hover();
  await expect(ref).toHaveAttribute('title', 'Note body');
  // Cmd/Ctrl+click on the reference jumps to the definition
  await caretAtText(page, 'here', 0);
  await ref.click({ modifiers: ['ControlOrMeta'] });
  await expect
    .poll(() => page.evaluate(() => getSelection()!.anchorNode?.parentElement?.closest('.md-block')?.getAttribute('data-type')))
    .toBe('footnote');
  // a second footnote gets the next label; an undefined one is flagged on hover
  await caretAtText(page, 'here.', 5);
  await palette(page, 'Footnote');
  await expect.poll(() => editorValue(page)).toBe('Text[^1] here.[^2]\n\n[^1]: Note body\n\n[^2]: ');
  await load(page, 'Dangling[^x]\n');
  await page.locator('.md-fnref').hover();
  await expect(page.locator('.md-fnref')).toHaveAttribute('title', /not defined/);
});

test('menu.para.front-matter: Paragraph › YAML Front Matter', async ({ page }) => {
  await load(page, '# T\n');
  await caretAtText(page, 'T', 1);
  await palette(page, 'YAML Front Matter');
  await expect.poll(() => editorValue(page)).toBe('---\n\n---\n\n# T\n');
  await expect(page.locator('.md-block[data-type=front_matter]')).toHaveCount(1);
  // a second invocation focuses the existing block instead of adding another
  expect(await menu(page, 'block:front_matter')).toBe(true);
  expect(await editorValue(page)).toBe('---\n\n---\n\n# T\n');
});

test('menu.format.sub-sup: Format › Superscript / Subscript', async ({ page }) => {
  await load(page, 'H2O and x2\n');
  await select(page, '2');
  await palette(page, 'Subscript');
  await expect.poll(() => editorValue(page)).toBe('H<sub>2</sub>O and x2\n');
  await expect(page.locator('.md-sub')).toHaveCSS('vertical-align', 'sub');
  await page.evaluate(() => {
    const n = [...document.querySelectorAll('.md-editor .md-content')][0].lastChild!;
    const i = n.textContent!.lastIndexOf('2');
    getSelection()!.setBaseAndExtent(n, i, n, i + 1);
    document.dispatchEvent(new Event('selectionchange'));
  });
  expect(await menu(page, 'mark:sup')).toBe(true);
  await expect.poll(() => editorValue(page)).toBe('H<sub>2</sub>O and x<sup>2</sup>\n');
  await expect(page.locator('.md-sup')).toHaveCSS('vertical-align', 'super');
  await menu(page, 'mark:sup');
  await expect.poll(() => editorValue(page)).toBe('H<sub>2</sub>O and x2\n');
});

test('menu.format.comment: Format › Comment (<!-- -->)', async ({ page }) => {
  await load(page, 'Keep this note out\n');
  await select(page, 'note');
  await palette(page, 'Comment');
  await expect.poll(() => editorValue(page)).toBe('Keep this <!-- note --> out\n');
  await expect(page.locator('.md-comment')).toHaveCount(1);
  expect(await page.evaluate(() => window.__margin!.editor.renderHTML())).not.toContain('note');
  await select(page, '<!-- note -->');
  await menu(page, 'mark:comment');
  await expect.poll(() => editorValue(page)).toBe('Keep this note out\n');
});
