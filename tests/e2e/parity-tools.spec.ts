/**
 * Parity epic #98: Paragraph › Table / Code Tools / Math Tools. One test per
 * surface; titles carry the surface id for the parity ledger binding. Commands
 * run from a real key press (F2 hook → `ed.exec`) like a menu click, so copy
 * gets user activation; the clipboard is read back through a real ⌘V.
 */
import { expect, test, type Page } from '@playwright/test';
import type { EditorCommand } from '../../src/contracts';
import { open, md, mod, caret } from './core-shared';
import { boot, caretAtText, editorValue } from './app-helpers';

async function run(page: Page, cmd: EditorCommand): Promise<boolean> {
  await page.evaluate((c) => {
    const w = window as unknown as { __res?: boolean; __cmd: EditorCommand; __hooked?: boolean };
    w.__cmd = c;
    w.__res = undefined;
    if (w.__hooked) return;
    w.__hooked = true;
    document.addEventListener(
      'keydown',
      (e) => {
        if (e.key !== 'F2') return;
        e.preventDefault();
        w.__res = window.__core.ed.exec(w.__cmd);
      },
      true,
    );
  }, cmd);
  await page.keyboard.press('F2');
  return page.evaluate(() => (window as unknown as { __res: boolean }).__res);
}

async function clipboard(page: Page): Promise<Record<string, string>> {
  await page.evaluate(() => {
    const w = window as unknown as { __clip: Record<string, string> };
    w.__clip = {};
    const sink = document.createElement('div');
    sink.id = 'sink';
    sink.contentEditable = 'true';
    document.body.append(sink);
    sink.addEventListener('paste', (e) => {
      e.preventDefault();
      for (const t of e.clipboardData!.types) w.__clip[t] = e.clipboardData!.getData(t);
    });
    sink.focus();
  });
  await page.keyboard.press(`${mod}+v`);
  const got = await page.evaluate(() => (window as unknown as { __clip: Record<string, string> }).__clip);
  await page.evaluate(() => document.getElementById('sink')?.remove());
  return got;
}

const cell = (page: Page, r: number, c: number) => page.locator(`.mb-table .mb-cell[data-r="${r}"][data-c="${c}"]`);
const TABLE = 'Intro\n\n| a | b |\n| --- | --- |\n| 1 | 2 |\n| 3 | 4 |\n';
const undo = (page: Page) => page.evaluate(() => window.__core.ed.exec({ kind: 'undo' }));

test.describe('parity: table, code and math tools (#98)', () => {
  test('menu.para.table: Paragraph › Table / Insert Table (with rows×columns dialog)', async ({ page }) => {
    await boot(page);
    await page.evaluate(() => window.__margin!.editor.setMarkdown('Hello\n'));
    await page.locator('.md-editor').click();
    void page.evaluate(() => window.__margin!.run('block:table'));
    const dlg = page.locator('.table-dialog');
    await expect(dlg).toBeVisible();
    await expect(dlg.locator('h2')).toHaveText('Insert Table');
    await expect(dlg.locator('input[name=Columns]')).toHaveValue('3');
    await expect(dlg.locator('input[name=Rows]')).toHaveValue('4');
    // negative: Escape cancels without touching the document
    await page.keyboard.press('Escape');
    await expect(dlg).toHaveCount(0);
    expect(await editorValue(page)).toBe('Hello\n');
    // the palette entry opens the same dialog; 4 columns × 2 rows (incl. header)
    void page.evaluate(() => window.__margin!.run('table:insert'));
    await dlg.locator('input[name=Columns]').fill('4');
    await dlg.locator('input[name=Rows]').fill('2');
    await page.keyboard.press('Enter');
    await expect(dlg).toHaveCount(0);
    await expect.poll(() => editorValue(page)).toContain('|   |   |   |   |\n| --- | --- | --- | --- |\n|   |   |   |   |');
    expect(await page.locator('.mb-table tr').count()).toBe(2);
    // the dialog remembers the last size; values clamp to 1..40 columns / 1..99 rows;
    // an emptied field reverts to 2 columns / 1 row; Enter in Columns moves to Rows
    void page.evaluate(() => window.__margin!.run('table:insert'));
    const cols = dlg.locator('input[name=Columns]');
    const rows = dlg.locator('input[name=Rows]');
    await expect(cols).toHaveValue('4');
    await expect(rows).toHaveValue('2');
    await cols.fill('');
    await cols.press('Enter');
    await expect(cols).toHaveValue('2');
    await expect(rows).toBeFocused();
    await rows.fill('500');
    await rows.blur();
    await expect(rows).toHaveValue('99');
    await page.keyboard.press('Escape');
    // inserted at the caret: a paragraph is split around the new table
    await page.evaluate(() => window.__margin!.editor.setMarkdown('abcdef\n'));
    await caretAtText(page, 'abcdef', 3);
    void page.evaluate(() => window.__margin!.run('block:table'));
    await cols.fill('1');
    await rows.fill('1');
    await rows.press('Enter');
    await expect.poll(() => editorValue(page)).toBe('abc\n\n|   |\n| --- |\n\ndef\n');
  });

  test('tools.table.rows-cols: Table: add row above/below, column before/after, delete row/column', async ({ page }) => {
    await open(page, TABLE);
    await cell(page, 1, 0).click();
    expect(await run(page, { kind: 'table', op: 'rowBelow' })).toBe(true);
    expect(await md(page)).toBe('Intro\n\n| a | b |\n| --- | --- |\n| 1 | 2 |\n|  |  |\n| 3 | 4 |\n');
    await undo(page);
    expect(await md(page)).toBe(TABLE);
    await cell(page, 1, 0).click();
    await run(page, { kind: 'table', op: 'rowAbove' });
    expect(await md(page)).toContain('| --- | --- |\n|  |  |\n| 1 | 2 |');
    await expect(cell(page, 1, 0)).toBeFocused(); // caret to the new row's first cell
    await undo(page);
    await cell(page, 2, 1).click();
    await run(page, { kind: 'table', op: 'colBefore' });
    expect(await md(page)).toMatch(/\| a +\| +\| b +\|\n/);
    await run(page, { kind: 'table', op: 'colAfter' });
    expect(await md(page)).toMatch(/\| a +\| +\| +\| b +\|\n/);
    await cell(page, 0, 1).click();
    await run(page, { kind: 'table', op: 'deleteCol' });
    await run(page, { kind: 'table', op: 'deleteCol' });
    expect(await md(page)).toMatch(/\| a +\| b +\|\n/);
    await cell(page, 2, 0).click();
    await run(page, { kind: 'table', op: 'deleteRow' });
    expect(await md(page)).not.toContain('| 3 | 4 |');
    // edge: Delete Row / Delete Column are no-ops on a one-row / one-column table
    await open(page, '|x|\n|-|\n');
    await cell(page, 0, 0).click();
    await run(page, { kind: 'table', op: 'deleteRow' });
    await run(page, { kind: 'table', op: 'deleteCol' });
    expect(await md(page)).toBe('|x|\n|-|\n');
    await open(page, TABLE);
    // negative: caret outside a table → not handled, document unchanged
    const before = await md(page);
    await caret(page, 0, 2);
    expect(await run(page, { kind: 'table', op: 'rowBelow' })).toBe(false);
    expect(await md(page)).toBe(before);
  });

  test('tools.table.move: Table: Move Row Up/Down, Move Column Left/Right', async ({ page }) => {
    await open(page, TABLE);
    await cell(page, 1, 0).click();
    await run(page, { kind: 'table', op: 'moveRowDown' });
    expect(await md(page)).toContain('| 3 | 4 |\n| 1 | 2 |');
    await run(page, { kind: 'table', op: 'moveRowUp' });
    expect(await md(page)).toContain('| 1 | 2 |\n| 3 | 4 |');
    await run(page, { kind: 'table', op: 'moveColRight' });
    expect(await md(page)).toContain('| b | a |');
    await undo(page);
    await undo(page);
    // a body row moved above the header becomes the header; blocked at the edges
    await cell(page, 1, 0).click();
    await run(page, { kind: 'table', op: 'moveRowUp' });
    expect(await md(page)).toMatch(/\| 1 +\| 2 +\|\n\| -+ \| -+ \|\n\| a +\| b +\|/);
    await undo(page);
    await cell(page, 0, 0).click();
    expect(await run(page, { kind: 'table', op: 'moveRowUp' })).toBe(true);
    expect(await run(page, { kind: 'table', op: 'moveColLeft' })).toBe(true);
    expect(await md(page)).toBe(TABLE);
  });

  test('tools.table.align-resize: Table: column alignment and Resize Table dialog', async ({ page }) => {
    await open(page, TABLE);
    await cell(page, 1, 1).click();
    await run(page, { kind: 'table', op: 'alignCenter' });
    expect(await md(page)).toContain('| :-: |');
    await run(page, { kind: 'table', op: 'alignRight' });
    expect(await md(page)).toMatch(/\| -+: \|/);
    await run(page, { kind: 'table', op: 'alignLeft' });
    expect(await md(page)).toMatch(/\| :-+ \|/);
    expect(await page.locator('.mb-table td').nth(1).evaluate((td) => (td as HTMLElement).style.textAlign)).toBe('left');
    await expect(page.locator('.mb-align[data-align="left"]')).toHaveClass(/mb-on/);
    // choosing the active alignment again resets the column
    await run(page, { kind: 'table', op: 'alignLeft' });
    expect(await page.locator('.mb-table td').nth(1).evaluate((td) => (td as HTMLElement).style.textAlign)).toBe('');
    // toolbar order matches Typora
    expect(await page.locator('.mb-table-tools > * ').evaluateAll((els) => els.map((e) => (e.querySelector('button') ?? e).getAttribute('title')))).toEqual([
      'Resize Table', 'Align Left', 'Align Center', 'Align Right', 'Delete Table', 'More Actions',
    ]);
    // Resize Table popover: Width x Height = columns × rows (incl. header)
    await page.locator('.mb-table-resize').click();
    const pop = page.locator('.mb-grid-pop');
    await expect(pop).toBeVisible();
    await expect(pop.locator('.mb-grid-label')).toHaveText('Width x Height');
    await expect(pop.locator('.mb-grid-width')).toHaveValue('2');
    await expect(pop.locator('.mb-grid-height')).toHaveValue('3');
    // hovering the preview grid previews a size
    await pop.locator('.mb-grid-cell[data-r="5"][data-c="7"]').hover();
    await expect(pop.locator('.mb-grid-width')).toHaveValue('7');
    await expect(pop.locator('.mb-grid-cell.mb-on')).toHaveCount(35);
    await pop.locator('.mb-grid-width').fill('3');
    await pop.locator('.mb-grid-height').fill('2');
    await pop.locator('.mb-grid-height').press('Enter');
    await expect(pop).toBeHidden();
    expect(await page.locator('.mb-table tr').count()).toBe(2);
    expect(await page.locator('.mb-table th').count()).toBe(3);
    expect(await md(page)).not.toContain('| 3 ');
    // resize from the menu command with explicit size; shrinking keeps ≥ 1×1
    await run(page, { kind: 'table', op: 'resize', rows: 0, cols: 0 });
    expect(await page.locator('.mb-table th').count()).toBe(1);
    await undo(page);
    expect(await page.locator('.mb-table th').count()).toBeGreaterThan(1);
  });

  test('tools.table.copy-delete: Table: Copy Table / Delete Table', async ({ page, context, browserName }) => {
    if (browserName === 'chromium') await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await open(page, '| a | **b** |\n|:--|---|\n| 1 | 2 |\n\nAfter\n');
    await cell(page, 1, 0).click();
    expect(await run(page, { kind: 'table', op: 'copy' })).toBe(true);
    const c = await clipboard(page);
    expect(c['text/plain']).toBe('| a | **b** |\n|:--|---|\n| 1 | 2 |');
    expect(c['text/html']).toContain('<strong>b</strong>');
    expect(c['text/html']).toMatch(/<td style="border:1px solid #ccc/);
    await cell(page, 1, 0).click();
    await run(page, { kind: 'table', op: 'prettify' });
    expect(await md(page)).toContain('| a    | **b** |\n| :--- | ----- |');
    expect(await run(page, { kind: 'table', op: 'delete' })).toBe(true);
    await expect(page.locator('.mb-table')).toHaveCount(0);
    expect(await md(page)).toBe('After\n'); // removed, not left as an empty paragraph
    await undo(page);
    await expect(page.locator('.mb-table')).toHaveCount(1);
  });

  test('tools.math.copy: Math tools: Copy Math / Copy as TeX / Copy as MathML / Delete Math', async ({ page, context, browserName }) => {
    if (browserName === 'chromium') await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await open(page, 'Inline $a^2$ here.\n\n$$\n\\frac{1}{2}\n$$\n\nEnd\n');
    await caret(page, 0, 9);
    expect(await run(page, { kind: 'math', op: 'copyTex' })).toBe(true);
    expect((await clipboard(page))['text/plain']).toBe('a^2');
    await page.locator('.mb-math-block').click();
    expect(await run(page, { kind: 'math', op: 'copyMathML' })).toBe(true);
    expect((await clipboard(page))['text/plain']).toMatch(/^<math[^>]*display="block"[\s\S]*<mfrac>/);
    await page.locator('.mb-math-block').click();
    expect(await run(page, { kind: 'math', op: 'delete' })).toBe(true);
    await expect(page.locator('.mb-math-block')).toHaveCount(0);
    expect(await md(page)).not.toContain('frac');
    // negative: inline math has no Delete Math (block-only, as in Typora); no math at the caret
    await caret(page, 0, 9);
    expect(await run(page, { kind: 'math', op: 'delete' })).toBe(false);
    expect(await md(page)).toContain('$a^2$');
    await caret(page, 0, 2);
    expect(await run(page, { kind: 'math', op: 'delete' })).toBe(false);
    expect(await run(page, { kind: 'math', op: 'copyTex' })).toBe(false);
  });

  test('tools.code.indent-prettify: Code tools: Auto Indent Selected/Whole Code, Prettify Source Code', async ({ page, context, browserName }) => {
    if (browserName === 'chromium') await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await open(page, '```js\nfunction f() {\nif (x) {\nreturn 1;\n}\n}\n```\n');
    await page.locator('.mb-code').click();
    await expect(page.locator('.mb-code .cm-content .tok-keyword').first()).toBeVisible(); // language loaded
    expect(await run(page, { kind: 'code', op: 'indentAll' })).toBe(true);
    await expect.poll(() => md(page)).toBe('```js\nfunction f() {\n    if (x) {\n        return 1;\n    }\n}\n```\n'); // Indent Size for Code default 4 (#100)
    await undo(page);
    expect(await run(page, { kind: 'code', op: 'copy' })).toBe(true);
    expect((await clipboard(page))['text/plain']).toContain('function f() {');
    // Auto Indent Selected Code only touches the selected line
    await page.locator('.mb-code .cm-line').nth(1).click();
    await run(page, { kind: 'code', op: 'indentSelected' });
    await expect.poll(() => md(page)).toContain('{\n    if (x) {\nreturn 1;');
    // negative: no code block at the caret
    await open(page, 'plain\n');
    await caret(page, 0, 1);
    expect(await run(page, { kind: 'code', op: 'indentAll' })).toBe(false);
  });

  test('tools.math.refresh: Math tools: Refresh All Math Expressions', async ({ page }) => {
    await open(page, 'A $x$ b.\n\n$$\ny\n$$\n');
    await expect(page.locator('.katex')).toHaveCount(2);
    await caret(page, 0, 1);
    const before = await md(page);
    expect(await run(page, { kind: 'math', op: 'refresh' })).toBe(true);
    await expect(page.locator('.katex')).toHaveCount(2);
    expect(await md(page)).toBe(before);
  });
});
