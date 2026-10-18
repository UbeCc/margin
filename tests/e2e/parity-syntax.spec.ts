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
  await expect(numbered).toHaveCount(0); // Typora default: No Automatic Equation Numbering
  await expect(ed(page).locator('.mb-error')).toHaveCount(1); // \abs unknown without physics
  const p = await md(page);
  const sel = p.locator('select[data-pref="markdown.mathNumbering"]');
  expect(await sel.locator('option').allTextContents()).toEqual([
    'No Automatic Equation Numbering',
    'Use AMS Numbering Rules',
    'Auto Numbering for All Math Equations',
  ]);
  await sel.selectOption('ams');
  await expect(numbered).toHaveCount(1); // only equation environments
  await sel.selectOption('all');
  await p.locator('[data-pref="markdown.mathPhysics"]').check();
  await close(page);
  await expect(numbered).toHaveCount(3);
  await expect(ed(page).locator('.mb-error')).toHaveCount(0);
  const p2 = await md(page);
  await p2.locator('select[data-pref="markdown.mathNumbering"]').selectOption('none');
  await close(page);
  await expect(numbered).toHaveCount(0);
  // Apply Line Break at \\ and \newline (on by default): off joins the lines of a display equation
  await setDoc(page, '$$\na \\\\ b\n$$\n');
  const lines = () => ed(page).locator('.katex-newline').count();
  expect(await lines()).toBe(1);
  const p3 = await md(page);
  await p3.locator('[data-pref="markdown.mathLineBreaks"]').uncheck();
  await close(page);
  await expect.poll(lines).toBe(0);
  expect(await editorValue(page)).toBe('$$\na \\\\ b\n$$\n');
});

test('syntax.extensions: Syntax support toggles: highlight, sub/sup, inline math, emoji shortcodes', async ({ page }) => {
  const src = 'H~2~O X^2^ ==key== $x$ :smile:\n';
  await setDoc(page, src);
  // Typora fresh-install defaults: inline math / sub / sup / highlight off; emoji shortcodes on
  await expect(ed(page).locator('.md-mark, .md-math, .md-sub, .md-sup')).toHaveCount(0);
  await expect(ed(page).locator('.md-entity-char')).toHaveText('😄');
  const p = await md(page);
  for (const k of ['subscript', 'superscript', 'highlight', 'inlineMath']) await p.locator(`[data-pref="markdown.${k}"]`).check();
  await p.locator('[data-pref="markdown.emoji"]').uncheck();
  await close(page);
  await expect(ed(page).locator('.md-sub')).toHaveText('~2~');
  // superscript is independent of subscript (Typora ties their visibility — deliberate fix)
  await expect(ed(page).locator('.md-sup')).toHaveText('^2^');
  await expect(ed(page).locator('.md-mark')).toHaveCount(1);
  await expect(ed(page).locator('.md-math')).toHaveCount(1);
  await expect(ed(page).locator('.md-entity')).toHaveCount(0);
  expect(await editorValue(page)).toBe(src);
  // persisted
  await page.reload();
  await expect(page.locator('.app.ready')).toBeVisible();
  await setDoc(page, src);
  await expect(ed(page).locator('.md-sub')).toHaveCount(1);
});

test('syntax.strict: Strict Mode (closer to GFM) and list/quote style preferences', async ({ page }) => {
  await setDoc(page, '#Heading\n\nitem\n\nsecond\n');
  await expect(ed(page).locator('.md-heading')).toHaveCount(0);
  const p = await md(page);
  await expect(p.getByText('(more strict to GFM spec)')).toBeVisible();
  await p.locator('[data-pref="markdown.strict"]').uncheck();
  await p.locator('select[data-pref="markdown.ulStyle"]').selectOption('*');
  await p.locator('select[data-pref="markdown.olStyle"]').selectOption('ones');
  await close(page);
  await expect(ed(page).locator('.md-heading.md-h1')).toHaveCount(1);
  expect(await editorValue(page)).toBe('#Heading\n\nitem\n\nsecond\n');
  await caretAtText(page, 'item', 1);
  await page.evaluate(() => window.__margin!.editor.exec({ kind: 'block', block: 'ul' }));
  expect(await editorValue(page)).toBe('#Heading\n\n* item\n\nsecond\n');
  await page.evaluate(() => window.__margin!.editor.exec({ kind: 'block', block: 'ul' }));
  await page.evaluate(() => window.__margin!.editor.exec({ kind: 'selectAll' }));
  await page.evaluate(() => window.__margin!.editor.exec({ kind: 'block', block: 'ol' }));
  expect(await editorValue(page)).toContain('1. item\n\n1. second\n'); // "1. ⋯ 1. ⋯ 1. ⋯"
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
  await expect(page.locator('.md-editor.md-visible-br')).toHaveCount(1); // Visible <br/>: on by default
  const p = await md(page);
  await p.locator('select[data-pref="markdown.preserveLineBreak"]').selectOption('ignore');
  await p.locator('[data-pref="markdown.visibleBr"]').uncheck();
  await p.locator('[data-pref="markdown.indentFirstLine"]').check();
  await close(page);
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await expect.poll(() => style('white-space')).not.toBe('pre-wrap');
  expect(await style('text-indent')).toBe('32px');
  await expect(ed(page).locator('.md-br')).toHaveCount(1); // the `\` hard break still breaks
  await expect(page.locator('.md-editor.md-visible-br')).toHaveCount(0);
  expect(await ed(page).locator('.md-html-br').evaluate((el) => getComputedStyle(el).fontSize)).toBe('0px');
  expect(await editorValue(page)).toBe(src);
});

test('syntax.save-normalize: On save: insert final newline, remap Unicode punctuation on parse', async ({ page }) => {
  // per document: Welcome.md ends with a newline, so the flag starts on for it
  await setDoc(page, 'no newline');
  await typeInEditor(page, '!');
  const v = await editorValue(page);
  expect(v.endsWith('\n')).toBe(false);
  await page.keyboard.press(`${MOD}+s`);
  await expect.poll(() => diskFile(page, `${ROOT}/Welcome.md`)).toBe(v + '\n');
  expect(await editorValue(page)).toBe(v); // the document itself is unchanged
  // toggled from the command palette: off → saved as is
  await page.keyboard.press(`${MOD}+Shift+a`);
  await page.keyboard.type('Insert Final New Line On Save');
  await page.keyboard.press('Enter');
  await expect(page.locator('.toast', { hasText: 'Insert Final New Line On Save: off' })).toBeVisible();
  await typeInEditor(page, '?');
  await page.keyboard.press(`${MOD}+s`);
  await expect.poll(() => diskFile(page, `${ROOT}/Welcome.md`)).toBe(v + '?');
  // Remap Unicode Punctuation on Parse: preference persisted (Markdown › Smart Punctuation)
  const p = await md(page);
  await p.locator('[data-pref=remapPunctuation]').check();
  await close(page);
  await expect.poll(() => page.evaluate(() => (window.__margin as unknown as { settings: { remapPunctuation: boolean } }).settings.remapPunctuation)).toBe(true);
});
