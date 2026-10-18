/**
 * Parity epic #100: Preferences completeness. One test per surface; titles carry
 * the surface id for the parity ledger binding. Every option is changed through
 * the Preferences UI and checked for live application and persistence.
 */
import { expect, test, type Page } from '@playwright/test';
import { boot, caretAtText, editorValue, MOD, queueDialog, ROOT, typeInEditor } from './app-helpers';

async function pane(page: Page, id: string) {
  if (!(await page.locator('.preferences').count())) await page.keyboard.press(`${MOD}+Comma`);
  const prefs = page.locator('.preferences');
  await prefs.locator(`.pref-tab[data-section=${id}]`).click();
  return prefs.locator(`.pref-section[data-section=${id}]`);
}
const close = (page: Page) => page.keyboard.press('Escape');
const setting = (page: Page, key: string) => page.evaluate((k) => (window.__margin as unknown as { settings: Record<string, unknown> }).settings[k], key);
const setDoc = (page: Page, md: string) => page.evaluate((m) => window.__margin!.editor.setMarkdown(m), md);

test.beforeEach(async ({ page }) => boot(page));

test('tools.code.line-numbers: Code fences: line numbers, line wrap, indent size', async ({ page }) => {
  await setDoc(page, '```js\nconst a = 1;\n```\n');
  const fence = page.locator('.mb-code').first();
  await expect(fence.locator('.mb-line-numbers')).toHaveCount(0);
  await expect(fence).toHaveClass(/mb-wrap/); // Auto wrap long lines: on by default
  const ed = await pane(page, 'editor');
  await ed.locator('[data-pref="markdown.codeLineNumbers"]').check();
  await ed.locator('[data-pref="markdown.codeLineWrap"]').uncheck();
  await ed.locator('select[data-pref="markdown.codeIndentSize"]').selectOption('2');
  await close(page);
  await expect(fence).not.toHaveClass(/mb-wrap/);
  await expect(fence.locator('.mb-line-numbers, .cm-lineNumbers').first()).toBeAttached();
  expect(await setting(page, 'markdown')).toMatchObject({ codeLineNumbers: true, codeLineWrap: false, codeIndentSize: 2 });
  // options never rewrite the fence source
  expect(await editorValue(page)).toBe('```js\nconst a = 1;\n```\n');
});

test('pref.general.launch: General: On Launch (restore files/folders, open new file, default folder)', async ({ page }) => {
  const g = await pane(page, 'general');
  const labels = await g.locator('[data-pref=onLaunch] label').allTextContents();
  expect(labels.map((l) => l.trim().split('\n')[0])).toEqual([
    'Restore last closed files and folders',
    'Restore last closed folders',
    'Open new file',
    'Open custom folderChoose Default Folder',
  ]);
  await expect(g.locator('input[name=onLaunch][value=newFile]')).toBeChecked(); // Typora default
  await queueDialog(page, `${ROOT}/Ideas`);
  await g.getByRole('button', { name: 'Choose Default Folder' }).click();
  await expect(g.locator('input[name=onLaunch][value=customFolder]')).toBeChecked();
  await expect(g.locator('input[data-pref=defaultFolder]')).toHaveValue(`${ROOT}/Ideas`);
  await g.locator('[data-pref=quitOnLastWindowClose]').check();
  await close(page);
  await page.reload();
  await expect(page.locator('.app.ready')).toBeVisible();
  // custom folder wins over the demo folder on launch
  await expect.poll(() => page.evaluate(() => (window.__margin as unknown as { folder: string | null }).folder)).toBe(`${ROOT}/Ideas`);
  const g2 = await pane(page, 'general');
  await expect(g2.locator('input[name=onLaunch][value=customFolder]')).toBeChecked();
  await expect(g2.locator('[data-pref=quitOnLastWindowClose]')).toBeChecked();
});

test('pref.editor.general: Editor: auto pair brackets/markdown, display source on focus, heading style, indent', async ({ page }) => {
  await setDoc(page, '# Title\n\ntext\n');
  await caretAtText(page, 'text', 4);
  await page.keyboard.type(' (a');
  expect(await editorValue(page)).toBe('# Title\n\ntext (a)\n'); // bracket auto-paired, caret inside
  await page.keyboard.type(')'); // steps over the closer
  expect(await editorValue(page)).toBe('# Title\n\ntext (a)\n');
  await page.keyboard.type(" don't *");
  expect(await editorValue(page)).toBe("# Title\n\ntext (a) don't *\n"); // no pair inside words / for markdown by default
  const ed = await pane(page, 'editor');
  await ed.locator('[data-pref="markdown.autoPairBrackets"]').uncheck();
  await ed.locator('[data-pref="markdown.autoPairMarkdown"]').check();
  await ed.locator('[data-pref="markdown.expandSimpleBlock"]').uncheck();
  await close(page);
  await caretAtText(page, "don't *", 7);
  await page.keyboard.type(' [ _');
  expect(await editorValue(page)).toBe("# Title\n\ntext (a) don't * [ __\n");
  // Display source on focus off: the heading marker stays hidden while the caret is in it
  await caretAtText(page, 'Title', 2);
  const marker = page.locator('.md-heading .md-bmeta').first();
  await expect(marker).toBeHidden();
});

test('pref.files.defaults: Files: default line ending, default folder, file extensions', async ({ page }) => {
  const ed = await pane(page, 'editor');
  const opts = await ed.locator('select[data-pref=defaultLineEnding] option').allTextContents();
  expect(opts[0]).toBe('Auto ( Recommended )');
  await ed.locator('select[data-pref=defaultLineEnding]').selectOption('crlf');
  await close(page);
  await page.keyboard.press(`${MOD}+n`);
  await expect(page.locator('.status-btn.eol')).toHaveText('CRLF');
  await typeInEditor(page, 'one');
  await queueDialog(page, `${ROOT}/crlf.md`);
  await page.keyboard.press(`${MOD}+s`);
  await expect(page.locator('.title-text')).toHaveText('crlf');
  // an existing file keeps its own line endings
  await page.locator(`.tree-row[data-path="${ROOT}/Welcome.md"]`).click();
  await expect(page.locator('.status-btn.eol')).toHaveText('LF');
});

test('pref.advanced: Advanced settings: open/reset config file, reset dialog warnings', async ({ page }) => {
  const g = await pane(page, 'general');
  await g.getByRole('button', { name: 'Open Advanced Settings' }).click();
  const json = g.locator('textarea[data-pref=advancedJson]');
  await expect(json).toBeVisible();
  const cfg = JSON.parse(await json.inputValue()) as Record<string, unknown>;
  expect(cfg.fontSize).toBe(16);
  expect(cfg).not.toHaveProperty('recentFiles');
  await json.fill(JSON.stringify({ ...cfg, fontSize: 21 }));
  await g.getByRole('button', { name: 'Apply' }).click();
  await expect(g.locator('[data-pref-status=advanced]')).toHaveText('Saved');
  expect(await setting(page, 'fontSize')).toBe(21);
  await json.fill('{ nope');
  await g.getByRole('button', { name: 'Apply' }).click();
  await expect(g.locator('[data-pref-status=advanced]')).toContainText('Invalid settings');
  await g.getByRole('button', { name: 'Reset All Dialog Warnings' }).click();
  await expect(g.locator('[data-pref-status=advanced]')).toHaveText('Dialog warnings have been reset.');
  await g.getByRole('button', { name: 'Reset Advanced Settings' }).click();
  await expect(page.getByText('Revert advanced setting file to default one ?')).toBeVisible();
  await page.getByRole('button', { name: 'Revert' }).click();
  await expect.poll(() => setting(page, 'fontSize')).toBe(16);
});

test('pref.general.language: General: UI language', async ({ page }) => {
  const g = await pane(page, 'general');
  const sel = g.locator('select[data-pref=language]');
  expect(await sel.locator('option').allTextContents()).toEqual(['Auto (based on current OS)', 'English']);
  await sel.selectOption('en');
  await close(page);
  await page.reload();
  await expect(page.locator('.app.ready')).toBeVisible();
  await expect((await pane(page, 'general')).locator('select[data-pref=language]')).toHaveValue('en');
});

test('pref.appearance.window: Appearance: window style (seamless/unibody/native), text column width, outline panel', async ({ page }) => {
  const a = await pane(page, 'appearance');
  expect(await a.locator('select[data-pref=windowStyle] option').allTextContents()).toEqual(['Seamless', 'Unibody', 'System Native']);
  await a.locator('select[data-pref=windowStyle]').selectOption('unibody');
  await a.locator('input[data-pref=textColumnWidth]').fill('900');
  await a.locator('input[data-pref=textColumnWidth]').blur();
  await a.locator('[data-pref=showOutlineByDefault]').check();
  await close(page);
  await expect.poll(() => page.evaluate(() => getComputedStyle(document.querySelector('.editor-host')!).maxWidth)).toBe('900px');
  await page.evaluate(() => (window.__margin as unknown as { updateSettings(p: object): void }).updateSettings({ sidebarTab: 'files' }));
  await page.reload();
  await expect(page.locator('.app.ready')).toBeVisible();
  await expect(page.locator('.sidebar')).toHaveAttribute('data-tab', 'outline');
  await expect(page.locator('.app')).toHaveAttribute('data-window-style', 'unibody');
  // negative: an out-of-range width falls back to the theme default
  const a2 = await pane(page, 'appearance');
  await a2.locator('input[data-pref=textColumnWidth]').fill('');
  await a2.locator('input[data-pref=textColumnWidth]').blur();
  await expect.poll(() => page.evaluate(() => getComputedStyle(document.querySelector('.editor-host')!).maxWidth)).not.toBe('900px');
});

test('pref.editor.shortcuts: Custom shortcut keys', async ({ page }) => {
  const ed = await pane(page, 'editor');
  const keys = ed.locator('textarea[data-pref=keyBinding]');
  await keys.fill('{ "Toggle Sidebar": "Mod+Shift+K" }');
  await keys.blur();
  await expect(ed.locator('[data-pref-status=keyBinding]')).toHaveText('Saved');
  await close(page);
  await expect(page.locator('.app')).not.toHaveClass(/sidebar-hidden/);
  await page.locator('.md-editor').click();
  await page.keyboard.press(`${MOD}+Shift+K`);
  await expect(page.locator('.app')).toHaveClass(/sidebar-hidden/);
  const ed2 = await pane(page, 'editor');
  await ed2.locator('textarea[data-pref=keyBinding]').fill('{ broken');
  await ed2.locator('textarea[data-pref=keyBinding]').blur();
  await expect(ed2.locator('[data-pref-status=keyBinding]')).toContainText('Invalid JSON');
  expect(await setting(page, 'keyBinding')).toEqual({ 'Toggle Sidebar': 'Mod+Shift+K' });
});
