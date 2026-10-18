/**
 * Parity epic #102: Markdown syntax options & whitespace/line-break settings.
 * Options are changed in Preferences › Markdown; each test checks live rendering
 * and that the markdown source is never rewritten (lossless).
 */
import { expect, test, type Page } from '@playwright/test';
import { boot, caretAtText, diskFile, editorValue, MOD, ROOT, typeInEditor } from './app-helpers';

async function md(page: Page) {
  if (!(await page.locator('.preferences').count())) await page.keyboard.press(`${MOD}+Comma`);
  await page.locator('.pref-tab[data-section=markdown]').click();
  return page.locator('.pref-section[data-section=markdown]');
}
const close = (page: Page) => page.keyboard.press('Escape');
const setDoc = (page: Page, m: string) => page.evaluate((x) => window.__margin!.editor.setMarkdown(x), m);
const ed = (page: Page) => page.locator('.md-editor');

test.beforeEach(async ({ page }) => boot(page));

test('tools.math.numbering: Math numbering options (auto-number, AMS rules, physics package)', async ({ page }) => {
  const src = '$$\n\\begin{equation}a=b\\end{equation}\n$$\n\n$$\nc=d\n$$\n\n$$\n\\abs{x}\n$$\n';
  await setDoc(page, src);
  const numbered = ed(page).locator('.mb-numbered');
  await expect(numbered).toHaveCount(1); // default: AMS rules (only equation environments)
  await expect(ed(page).locator('.mb-error')).toHaveCount(1); // \abs unknown without physics
  const p = await md(page);
  const sel = p.locator('select[data-pref="markdown.mathNumbering"]');
  expect(await sel.locator('option').allTextContents()).toEqual([
    'Auto Numbering for All Math Equations',
    'Use AMS Numbering Rules',
    'No Automatic Equation Numbering',
  ]);
  await sel.selectOption('all');
  await p.locator('[data-pref="markdown.mathPhysics"]').check();
  await close(page);
  await expect(numbered).toHaveCount(3);
  await expect(ed(page).locator('.mb-error')).toHaveCount(0);
  const p2 = await md(page);
  await p2.locator('select[data-pref="markdown.mathNumbering"]').selectOption('none');
  await close(page);
  await expect(numbered).toHaveCount(0);
  expect(await editorValue(page)).toBe(src);
});

test('syntax.extensions: Syntax support toggles: highlight, sub/sup, inline math, emoji shortcodes', async ({ page }) => {
  const src = 'H~2~O X^2^ ==key== $x$ :smile:\n';
  await setDoc(page, src);
  await expect(ed(page).locator('.md-mark')).toHaveCount(1);
  await expect(ed(page).locator('.md-math')).toHaveCount(1);
  await expect(ed(page).locator('.md-sub, .md-sup')).toHaveCount(0);
  await expect(ed(page).locator('.md-entity')).toHaveCount(0);
  const p = await md(page);
  for (const k of ['subscript', 'superscript', 'emoji']) await p.locator(`[data-pref="markdown.${k}"]`).check();
  for (const k of ['highlight', 'inlineMath']) await p.locator(`[data-pref="markdown.${k}"]`).uncheck();
  await close(page);
  await expect(ed(page).locator('.md-sub')).toHaveText('~2~');
  await expect(ed(page).locator('.md-sup')).toHaveText('^2^');
  await expect(ed(page).locator('.md-entity-char')).toHaveText('😄');
  await expect(ed(page).locator('.md-mark')).toHaveCount(0);
  await expect(ed(page).locator('.md-math')).toHaveCount(0);
  expect(await editorValue(page)).toBe(src);
  // persisted
  await page.reload();
  await expect(page.locator('.app.ready')).toBeVisible();
  await setDoc(page, src);
  await expect(ed(page).locator('.md-sub')).toHaveCount(1);
});

test('syntax.strict: Strict Mode (closer to GFM) and list/quote style preferences', async ({ page }) => {
  await setDoc(page, '#Heading\n\nitem\n');
  await expect(ed(page).locator('.md-heading')).toHaveCount(0);
  const p = await md(page);
  await expect(p.getByText('(more strict to GFM spec)')).toBeVisible();
  await p.locator('[data-pref="markdown.strict"]').uncheck();
  await p.locator('select[data-pref="markdown.ulStyle"]').selectOption('*');
  await p.locator('select[data-pref="markdown.olStyle"]').selectOption(')');
  await close(page);
  await expect(ed(page).locator('.md-heading.md-h1')).toHaveCount(1);
  expect(await editorValue(page)).toBe('#Heading\n\nitem\n');
  await caretAtText(page, 'item', 1);
  await page.evaluate(() => window.__margin!.editor.exec({ kind: 'block', block: 'ul' }));
  expect(await editorValue(page)).toBe('#Heading\n\n* item\n');
  await page.evaluate(() => window.__margin!.editor.exec({ kind: 'block', block: 'ul' }));
  await page.evaluate(() => window.__margin!.editor.exec({ kind: 'block', block: 'ol' }));
  expect(await editorValue(page)).toBe('#Heading\n\n1) item\n');
  // existing markers are never rewritten
  await setDoc(page, '- a\n1. b\n');
  expect(await editorValue(page)).toBe('- a\n1. b\n');
});

test('syntax.whitespace: Whitespace & line breaks: preserve single line break, visible <br/>, first-line indent, \\\\ line break', async ({ page }) => {
  const src = 'one\ntwo<br/>three\\\nfour\n\nnext\n';
  await setDoc(page, src);
  const para = ed(page).locator('.md-paragraph').first().locator('.md-content');
  const style = (prop: string) => para.evaluate((el, p) => getComputedStyle(el).getPropertyValue(p), prop);
  expect(await style('white-space')).toBe('pre-wrap');
  await expect(ed(page).locator('.md-br')).toHaveCount(1);
  const p = await md(page);
  await p.locator('input[name="markdown.preserveLineBreak"][value=ignore]').check();
  await p.locator('[data-pref="markdown.visibleBr"]').check();
  await p.locator('[data-pref="markdown.indentFirstLine"]').check();
  await p.locator('[data-pref="markdown.backslashBreak"]').uncheck();
  await close(page);
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await expect.poll(() => style('white-space')).not.toBe('pre-wrap');
  expect(await style('text-indent')).toBe('32px');
  await expect(ed(page).locator('.md-br')).toHaveCount(0);
  await expect(page.locator('.md-editor.md-visible-br')).toHaveCount(1);
  expect(await editorValue(page)).toBe(src);
});

test('syntax.save-normalize: On save: insert final newline, remap Unicode punctuation on parse', async ({ page }) => {
  await setDoc(page, 'no newline');
  await typeInEditor(page, '!');
  const v = await editorValue(page);
  expect(v.endsWith('\n')).toBe(false);
  const p = await md(page);
  await p.locator('[data-pref=remapPunctuation]').check();
  await page.locator('.pref-tab[data-section=editor]').click();
  await page.locator('[data-pref=insertFinalNewline]').check();
  await close(page);
  await page.locator('.md-editor').click();
  await page.keyboard.press(`${MOD}+s`);
  await expect.poll(() => diskFile(page, `${ROOT}/Welcome.md`)).toBe(v + '\n');
  expect(await editorValue(page)).toBe(v); // the document itself is unchanged
});
