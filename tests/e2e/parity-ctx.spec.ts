/**
 * Parity epic #97: editor context menus. One test per surface; titles carry the
 * surface id for the parity ledger binding. Menus are driven with real
 * right-clicks and clicks (user activation, so copy is granted like a native
 * menu); clipboard contents are read back with a real ⌘V into a scratch field.
 */
import { expect, test, type Page } from '@playwright/test';
import { boot, caretAtText, editorValue, MOD } from './app-helpers';

async function load(page: Page, md: string): Promise<void> {
  await boot(page);
  await page.evaluate((m) => window.__margin!.editor.setMarkdown(m), md);
}

const menu = (page: Page) => page.locator('.context-menu:not(.context-submenu)');
const item = (page: Page, label: string) => page.locator('.context-menu .context-item', { hasText: new RegExp(`^.?${label.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')}`) }).first();
async function labels(page: Page): Promise<string[]> {
  await expect(menu(page)).toBeVisible();
  return menu(page).locator(':scope > .context-item .context-label').allTextContents();
}

/** Select the first occurrence of `text` in the document (DOM range, like a drag). */
async function selectText(page: Page, text: string): Promise<void> {
  await page.evaluate((text) => {
    const root = document.querySelector('.md-editor') as HTMLElement;
    const w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    for (let n = w.nextNode(); n; n = w.nextNode()) {
      const i = n.textContent!.indexOf(text);
      if (i < 0 || (n.parentElement as HTMLElement).closest('.md-meta')) continue;
      root.focus();
      const r = document.createRange();
      r.setStart(n, i);
      r.setEnd(n, i + text.length);
      getSelection()!.removeAllRanges();
      getSelection()!.addRange(r);
      return;
    }
    throw new Error('not found: ' + text);
  }, text);
}

/** Right-click the middle of the current selection. */
async function rightClickSelection(page: Page): Promise<void> {
  const b = await page.evaluate(() => {
    const r = getSelection()!.getRangeAt(0).getClientRects()[0];
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  });
  await page.mouse.click(b.x, b.y, { button: 'right' });
}

/** Paste the system clipboard into a scratch field (real ⌘V) and return its text/plain. */
async function clipboardText(page: Page): Promise<string> {
  await page.evaluate(() => {
    const w = window as unknown as { __clip: string };
    w.__clip = '';
    const sink = document.createElement('div');
    sink.id = 'sink';
    sink.contentEditable = 'true';
    document.body.append(sink);
    sink.addEventListener('paste', (e) => {
      e.preventDefault();
      w.__clip = e.clipboardData!.getData('text/plain');
    });
    sink.focus();
  });
  await page.keyboard.press(`${MOD}+v`);
  const got = await page.evaluate(() => (window as unknown as { __clip: string }).__clip);
  await page.evaluate(() => document.getElementById('sink')?.remove());
  return got;
}

test.describe('parity: context menus (#97)', () => {
  test.beforeEach(async ({ context, browserName }) => {
    if (browserName === 'chromium') await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  });

  test('ctx.framework: Context-menu framework: target-aware item lists for the editor', async ({ page }) => {
    await load(page, 'Plain text here.\n\n| a | b |\n|---|---|\n| 1 | 2 |\n');
    await page.locator('.md-editor .md-paragraph', { hasText: 'Plain text' }).click({ button: 'right' });
    await expect(menu(page)).toBeVisible();
    expect(await labels(page)).toEqual(['Cut', 'Copy', 'Paste', 'Copy / Paste As…']);
    await page.keyboard.press('Escape');
    await expect(page.locator('.context-menu')).toHaveCount(0);

    // a table cell gets the Table submenu and paragraph insertion
    await page.locator('.md-editor td').first().click({ button: 'right' });
    expect(await labels(page)).toEqual(['Cut', 'Copy', 'Paste', 'Copy / Paste As…', 'Table', 'Insert Paragraph Before', 'Insert Paragraph After']);
    await item(page, 'Table').hover();
    await expect(page.locator('.context-submenu')).toContainText('Add Row Below');
    await item(page, 'Add Row Below').click();
    await expect.poll(() => editorValue(page)).toMatch(/\| 1 \| 2 \|\n\|\s*\|\s*\|/);

    // outside the document there is no editor menu
    await page.locator('.statusbar').click({ button: 'right' });
    await expect(page.locator('.context-menu')).toHaveCount(0);
  });

  test('ctx.text: Text context menu: cut/copy/paste, copy-as, insert, format, paragraph submenus, search with…', async ({ page, browserName }) => {
    await load(page, 'Some **bold** words\n');
    await selectText(page, 'bold');
    await rightClickSelection(page);
    expect(await labels(page)).toEqual(['Cut', 'Copy', 'Paste', 'Copy / Paste As…', 'Search with Google']);
    await item(page, 'Copy / Paste As…').hover();
    await expect(page.locator('.context-submenu .context-label')).toHaveText(['Copy as Markdown', 'Copy as HTML Code', 'Copy without Theme Styling', 'Paste as Plain Text']);
    await item(page, 'Copy as Markdown').click();
    expect(await clipboardText(page)).toContain('bold');

    // Copy from the menu, then Paste from the menu where the pointer is
    await selectText(page, 'bold');
    await rightClickSelection(page);
    await item(page, 'Copy').click();
    const box = (await page.locator('.md-editor .md-paragraph').boundingBox())!;
    await page.mouse.click(box.x + box.width - 2, box.y + box.height / 2, { button: 'right' });
    await expect(item(page, 'Cut')).toBeDisabled();
    if (browserName === 'webkit') {
      // the browser build cannot read the clipboard from a menu click in WebKit; emulate the desktop native read
      await page.evaluate(() => {
        (window.__MARGIN_WEB__ as unknown as { readClipboard: unknown }).readClipboard = async () => ({ plain: 'bold', html: null, rtfHtml: null });
      });
    }
    await item(page, 'Paste').click();
    await expect.poll(() => editorValue(page)).toMatch(/bold[\s\S]*bold/);
  });

  test('ctx.link: Link context menu: Open Link / Copy Link Address / Hyperlink Actions', async ({ page }) => {
    await load(page, 'See [the site](https://example.com/x) now\n');
    await page.evaluate(() => {
      const w = window as unknown as { __opened: string[] };
      w.__opened = [];
      window.open = ((u: string) => (w.__opened.push(u), null)) as typeof window.open;
    });
    await page.locator('.md-editor .md-link').click({ button: 'right' });
    expect(await labels(page)).toEqual(['Open Link', 'Cut', 'Copy', 'Copy Link Address', 'Paste', 'Copy / Paste As…']);
    await item(page, 'Copy Link Address').click();
    expect(await clipboardText(page)).toBe('https://example.com/x');
    await page.locator('.md-editor .md-link').click({ button: 'right' });
    await item(page, 'Open Link').click();
    await expect.poll(() => page.evaluate(() => (window as unknown as { __opened: string[] }).__opened)).toEqual(['https://example.com/x']);
  });

  test('ctx.block-generic: Block context menu: Insert Paragraph Before/After, Delete (atomic blocks)', async ({ page }) => {
    await load(page, 'Top\n\n$$\nE=mc^2\n$$\n\nEnd\n');
    const math = page.locator('.md-editor .md-block[data-type=math_block]');
    await math.click({ button: 'right' });
    expect(await labels(page)).toEqual(['Cut', 'Copy', 'Paste', 'Copy / Paste As…', 'Edit', 'Copy Math', 'Code Tools', 'Insert Paragraph Before', 'Insert Paragraph After', 'Delete']);
    await item(page, 'Insert Paragraph After').click();
    await expect.poll(() => editorValue(page)).toMatch(/^Top\n\n\$\$\nE=mc\^2\n\$\$\n\n\n+End\n$/);
    await expect(page.locator('.md-editor .md-paragraph')).toHaveCount(3);
    await math.click({ button: 'right' });
    await item(page, 'Delete').click();
    await expect.poll(() => editorValue(page)).not.toContain('E=mc^2');
    await page.keyboard.press(`${MOD}+z`);
    await expect.poll(() => editorValue(page)).toContain('E=mc^2');
  });

  test('ctx.emoji: Emoji/inline-math context entries (copy emoji, copy inline math)', async ({ page }) => {
    await load(page, 'Area $a^2+b^2$ here\n');
    await page.locator('.md-editor .md-math .md-math-render').click({ button: 'right', force: true });
    expect(await labels(page)).toEqual(['Copy Math', 'Cut', 'Copy', 'Paste', 'Copy / Paste As…']);
    await item(page, 'Copy Math').hover();
    await item(page, 'Copy as Tex').click();
    expect(await clipboardText(page)).toBe('a^2+b^2');
  });

  test('tools.code.delete: Code tools: Delete Code Block', async ({ page }) => {
    await load(page, 'Before\n\n```js\nlet a = 1;\n```\n\nAfter\n');
    const code = page.locator('.md-editor .md-block[data-type=code_fence]');
    await code.locator('.cm-content').click({ button: 'right' });
    expect(await labels(page)).toEqual(['Cut', 'Copy', 'Paste', 'Copy / Paste As…', 'Code Tools', 'Insert Paragraph Before', 'Insert Paragraph After', 'Delete Code Block']);
    await item(page, 'Code Tools').hover();
    await item(page, 'Copy Code Content').click();
    expect(await clipboardText(page)).toBe('let a = 1;');
    await code.locator('.cm-content').click({ button: 'right' });
    await item(page, 'Delete Code Block').click();
    await expect.poll(() => editorValue(page)).not.toContain('let a');
    expect(await editorValue(page)).toContain('Before');
  });
});
