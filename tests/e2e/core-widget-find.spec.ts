/**
 * Find / replace inside widget blocks (#35): find-next walks paragraphs → code
 * fence → table cell → math source, replace(-all) is lossless and one undo step.
 */
import { expect, test, type Page } from '@playwright/test';
import { open, md, mod } from './core-shared';

const DOC = [
  'alpha one',
  '',
  '```js',
  'let alpha = 2;',
  '```',
  '',
  '| h | k |',
  '| - | - |',
  '| x alpha y | z |',
  '',
  '> $$',
  '> alpha^2',
  '> $$',
  '',
  '---',
  '',
  'tail alpha',
  '',
].join('\n');

const exec = (page: Page, cmd: object) => page.evaluate((c) => window.__core.ed.exec(c as never), cmd);
const find = (page: Page, query: string, backwards = false) => exec(page, { kind: 'find', query, backwards });

/** Where the selection is: the widget kind holding focus (or 'text') and the selected text. */
const where = (page: Page) =>
  page.evaluate(() => {
    const a = document.activeElement as HTMLElement | null;
    const w = a?.closest<HTMLElement>('.mb-block');
    const kind = w ? w.dataset.type! : a?.classList.contains('md-editor') ? 'text' : (a?.tagName ?? 'none');
    const extra = a?.classList.contains('mb-cell') ? a.textContent : null;
    return { kind, sel: getSelection()!.toString(), cell: extra };
  });

test.describe('find inside widgets (#35)', () => {
  test('find-next cycles paragraph → code → table cell → math → paragraph; find-prev goes back', async ({ page }) => {
    await open(page, DOC);
    expect(await find(page, 'alpha')).toBe(true);
    expect(await where(page)).toMatchObject({ kind: 'text', sel: 'alpha' });
    await find(page, 'alpha');
    await expect.poll(() => where(page)).toMatchObject({ kind: 'code_fence', sel: 'alpha' });
    await expect(page.locator('.mb-code .cm-editor')).toBeVisible();
    await find(page, 'alpha');
    await expect.poll(() => where(page)).toMatchObject({ kind: 'table', sel: 'alpha', cell: 'x alpha y' });
    await find(page, 'alpha');
    await expect.poll(() => where(page)).toMatchObject({ kind: 'math_block', sel: 'alpha' });
    await expect(page.locator('.mb-math-block.mb-editing')).toHaveCount(1);
    await find(page, 'alpha');
    await expect.poll(() => where(page)).toMatchObject({ kind: 'text', sel: 'alpha' });
    expect(await page.evaluate(() => getSelection()!.anchorNode!.parentElement!.closest('.md-block')!.textContent)).toContain('tail');
    // backwards: tail → math → table
    await find(page, 'alpha', true);
    await expect.poll(() => where(page)).toMatchObject({ kind: 'math_block', sel: 'alpha' });
    await find(page, 'alpha', true);
    await expect.poll(() => where(page)).toMatchObject({ kind: 'table', sel: 'alpha' });
    expect(await md(page)).toBe(DOC);
  });

  test('a match on widget syntax falls back to focusing the whole widget', async ({ page }) => {
    await open(page, 'p\n\n```js\nx\n```\n');
    expect(await find(page, '```js')).toBe(true);
    await expect.poll(async () => (await where(page)).kind).toBe('code_fence');
    expect(await md(page)).toBe('p\n\n```js\nx\n```\n');
  });

  test('replace-all across widgets is lossless and one undo step', async ({ page }) => {
    await open(page, DOC);
    expect(await exec(page, { kind: 'replace', query: 'alpha', replacement: 'beta', all: true })).toBe(true);
    expect(await md(page)).toBe(DOC.replace(/alpha/g, 'beta'));
    await expect(page.locator('.mb-code')).toContainText('let beta = 2;');
    await expect(page.locator('.mb-table .mb-cell').filter({ hasText: 'x beta y' })).toHaveCount(1);
    await page.locator('.md-editor').focus();
    await page.keyboard.press(`${mod}+z`);
    expect(await md(page)).toBe(DOC);
    await expect(page.locator('.mb-code')).toContainText('let alpha = 2;');
  });

  test('replace inside a code fence and a table cell, then undo each', async ({ page }) => {
    await open(page, DOC);
    await find(page, 'alpha');
    await find(page, 'alpha'); // code fence
    await expect.poll(async () => (await where(page)).kind).toBe('code_fence');
    expect(await exec(page, { kind: 'replace', query: 'alpha', replacement: 'gamma' })).toBe(true);
    expect(await md(page)).toBe(DOC.replace('let alpha', 'let gamma'));
    // the next match (table cell) is selected
    await expect.poll(() => where(page)).toMatchObject({ kind: 'table', sel: 'alpha' });
    expect(await exec(page, { kind: 'replace', query: 'alpha', replacement: 'delta' })).toBe(true);
    expect(await md(page)).toBe(DOC.replace('let alpha', 'let gamma').replace('x alpha y', 'x delta y'));
    await expect.poll(() => where(page)).toMatchObject({ kind: 'math_block', sel: 'alpha' });
    expect(await exec(page, { kind: 'undo' })).toBe(true);
    expect(await md(page)).toBe(DOC.replace('let alpha', 'let gamma'));
    expect(await exec(page, { kind: 'undo' })).toBe(true);
    expect(await md(page)).toBe(DOC);
  });

  test('find-next keeps cycling when focus is in a find bar outside the editor', async ({ page }) => {
    await open(page, DOC);
    await page.evaluate(() => document.body.append(Object.assign(document.createElement('input'), { id: 'fb' })));
    const kinds: string[] = [];
    for (let k = 0; k < 5; k++) {
      await page.locator('#fb').focus();
      await find(page, 'alpha');
      await page.waitForTimeout(0);
      kinds.push((await where(page)).kind);
    }
    expect(kinds).toEqual(['text', 'code_fence', 'table', 'math_block', 'text']);
  });
});
