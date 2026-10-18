import { expect, test, type Page } from '@playwright/test';
import { boot, diskFile, editorValue, MOD, queueDialog, ROOT, typeInEditor } from './app-helpers';

/**
 * Parity verifiers for the file-lifecycle epic (#94). One test per surface; titles start
 * with the surface id so docs/parity can bind them.
 */

test.beforeEach(async ({ page }) => boot(page));

const tabs = (page: Page) => page.locator('.tab-bar .tab');
const activeTab = (page: Page) => page.locator('.tab-bar .tab[aria-selected="true"]');
const openFiles = (page: Page, paths: string[]) => page.evaluate((p) => window.__MARGIN_WEB__!.openFiles(p), paths);
const menu = (page: Page, action: string) => page.evaluate((a) => window.__MARGIN_WEB__!.triggerMenu(a as never), action);
const isDirty = (page: Page) => page.evaluate(() => window.__margin!.doc.dirty);

test('menu.file.tabs: Tabs: New Tab, switch between opened documents, next/previous tab', async ({ page }) => {
  // One document: no tab bar.
  await expect(page.locator('.tab-bar')).toBeHidden();
  await page.keyboard.press(`${MOD}+t`);
  await expect(tabs(page)).toHaveCount(2);
  await expect(activeTab(page)).toHaveText(/Untitled/);
  await expect(page.locator('.title-text')).toHaveText('Untitled');
  await page.keyboard.type('second doc');
  await expect(activeTab(page)).toHaveClass(/dirty/);

  // Previous / next tab keep each document's content and caret.
  await page.keyboard.press(`${MOD}+Shift+BracketLeft`);
  await expect(page.locator('.title-text')).toHaveText('Welcome');
  await expect.poll(() => editorValue(page)).toContain('# Welcome to Margin');
  await page.keyboard.press(`${MOD}+Shift+BracketRight`);
  await expect.poll(() => editorValue(page)).toBe('second doc');
  await page.keyboard.type('!');
  await expect.poll(() => editorValue(page)).toBe('second doc!');

  // Clicking a tab switches; a sidebar click replaces the current document (tab count stays).
  await tabs(page).first().click();
  await expect(page.locator('.title-text')).toHaveText('Welcome');
  await page.locator(`.file-tree [data-path="${ROOT}/Ideas"]`).click();
  await page.locator(`.file-tree [data-path="${ROOT}/Ideas/Roadmap.md"]`).click();
  await expect(page.locator('.title-text')).toHaveText('Roadmap');
  await expect(tabs(page)).toHaveCount(2);
  // Cmd/Ctrl+click opens beside; an already-open file is focused, not duplicated.
  await page.locator(`.file-tree [data-path="${ROOT}/Welcome.md"]`).click({ modifiers: ['ControlOrMeta'] });
  await expect(tabs(page)).toHaveCount(3);
  await page.locator(`.file-tree [data-path="${ROOT}/Ideas/Roadmap.md"]`).click();
  await expect(tabs(page)).toHaveCount(3);
  await expect(page.locator('.title-text')).toHaveText('Roadmap');

  // Closing a dirty tab asks; Cancel keeps it.
  await page.locator('.tab', { hasText: 'Untitled' }).locator('.tab-close').click();
  await expect(page.locator('.dialog')).toContainText('Do you want to save the changes');
  await page.locator('.dialog [data-id=cancel]').click();
  await expect(tabs(page)).toHaveCount(3);
  await page.locator('.tab', { hasText: 'Untitled' }).locator('.tab-close').click();
  await page.locator('.dialog [data-id=discard]').click();
  await expect(tabs(page)).toHaveCount(2);
  // Middle click closes too; with one document left the bar hides again.
  await page.locator('.tab', { hasText: 'Welcome' }).click({ button: 'middle' });
  await expect(page.locator('.tab-bar')).toBeHidden();
  await expect(page.locator('.title-text')).toHaveText('Roadmap');
});

test('menu.file.new-window: File › New Window / Open in New Window', async ({ page }) => {
  const [win] = await Promise.all([page.context().waitForEvent('page'), page.keyboard.press(`${MOD}+Shift+n`)]);
  await expect(win.locator('.app.ready')).toBeVisible();
  await expect(win.locator('.title-text')).toHaveText('Untitled');
  // The new window starts with an empty document but keeps this window's sidebar folder
  // (Typora native-commands §2.3).
  await expect(win.locator(`.file-tree [data-path="${ROOT}/Welcome.md"]`)).toBeVisible();
  await expect(win.locator('.tab-bar')).toBeHidden();
  expect(await win.evaluate(() => window.__margin!.editor.getMarkdown())).toBe('');
  // The first window is untouched.
  await expect(page.locator('.title-text')).toHaveText('Welcome');

  // Sidebar › Open in New Window shows that file in a second window.
  await page.locator(`.file-tree [data-path="${ROOT}/notes.txt"]`).click({ button: 'right' });
  const [win2] = await Promise.all([
    page.context().waitForEvent('page'),
    page.locator('.context-item', { hasText: 'Open in New Window' }).click(),
  ]);
  await expect(win2.locator('.app.ready')).toBeVisible();
  await expect(win2.locator('.title-text')).toHaveText('notes');
  await expect(page.locator('.title-text')).toHaveText('Welcome');
});

test('menu.file.reopen-closed: File › Reopen Closed File', async ({ page }) => {
  // Nothing closed yet: an explanatory toast, no new tab.
  await page.keyboard.press(`${MOD}+Shift+t`);
  await expect(page.locator('.toast')).toContainText('No recently closed file');
  await openFiles(page, [`${ROOT}/Ideas/Roadmap.md`]);
  await expect(tabs(page)).toHaveCount(2);
  await page.keyboard.press(`${MOD}+w`);
  await expect(page.locator('.tab-bar')).toBeHidden();
  await expect(page.locator('.title-text')).toHaveText('Welcome');
  await page.keyboard.press(`${MOD}+Shift+t`);
  await expect(page.locator('.title-text')).toHaveText('Roadmap');
  await expect(tabs(page)).toHaveCount(2);
  // A file deleted since closing is skipped.
  await page.keyboard.press(`${MOD}+w`);
  await page.evaluate((p) => window.__MARGIN_WEB__!.externalRemove(p), `${ROOT}/Ideas/Roadmap.md`);
  await page.keyboard.press(`${MOD}+Shift+t`);
  await expect(page.locator('.toast').last()).toContainText('No recently closed file');
  await expect(page.locator('.title-text')).toHaveText('Welcome');
});

test('menu.file.save-all: File › Save All', async ({ page }) => {
  await typeInEditor(page, '\nwelcome edit');
  await openFiles(page, [`${ROOT}/Ideas/Roadmap.md`]);
  await typeInEditor(page, '\nroadmap edit');
  await page.keyboard.press(`${MOD}+t`);
  await page.keyboard.type('# Draft');
  await expect(page.locator('.tab.dirty')).toHaveCount(3);
  await queueDialog(page, `${ROOT}/Draft.md`);
  await page.keyboard.press(`${MOD}+Alt+s`);
  await expect(page.locator('.tab.dirty')).toHaveCount(0);
  expect(await diskFile(page, `${ROOT}/Welcome.md`)).toContain('welcome edit');
  expect(await diskFile(page, `${ROOT}/Ideas/Roadmap.md`)).toContain('roadmap edit');
  expect(await diskFile(page, `${ROOT}/Draft.md`)).toBe('# Draft');
  await expect(page.locator('.toast').last()).toContainText('Saved 3 files');
  // Nothing left to save: says so instead of writing.
  await menu(page, 'saveAll');
  await expect(page.locator('.toast').last()).toContainText('No unsaved changes');
  // Cancelling the Save As of an untitled document stops Save All.
  await page.keyboard.press(`${MOD}+t`);
  await page.keyboard.type('x');
  await queueDialog(page, null);
  await page.keyboard.press(`${MOD}+Alt+s`);
  await expect.poll(() => isDirty(page)).toBe(true);
});

test('beh.files.snapshot-undo: Reopen keeps undo history and caret (per-document snapshot)', async ({ page }) => {
  await openFiles(page, [`${ROOT}/Ideas/Roadmap.md`]);
  await expect(page.locator('.title-text')).toHaveText('Roadmap');
  await typeInEditor(page, '\nkept in history');
  await page.keyboard.press(`${MOD}+s`);
  await expect.poll(() => isDirty(page)).toBe(false);
  await page.keyboard.press(`${MOD}+w`);
  await expect(page.locator('.title-text')).toHaveText('Welcome');
  // Reopen (here: from the sidebar) restores the parked document: undo still works, caret kept.
  await page.locator(`.file-tree [data-path="${ROOT}/Ideas/Roadmap.md"]`).click({ modifiers: ['ControlOrMeta'] });
  await expect(page.locator('.title-text')).toHaveText('Roadmap');
  await page.keyboard.type(' more');
  await expect.poll(() => editorValue(page)).toContain('kept in history more');
  await page.keyboard.press(`${MOD}+z`);
  await page.keyboard.press(`${MOD}+z`);
  await expect.poll(() => editorValue(page)).not.toContain('kept in history');

  // Changed on disk while closed: the snapshot is stale, so the disk version opens fresh.
  await page.keyboard.press(`${MOD}+s`);
  await page.keyboard.press(`${MOD}+w`);
  await page.evaluate((p) => window.__MARGIN_WEB__!.externalWrite(p, '# Rewritten elsewhere\n'), `${ROOT}/Ideas/Roadmap.md`);
  await page.keyboard.press(`${MOD}+Shift+t`);
  await expect.poll(() => editorValue(page)).toBe('# Rewritten elsewhere\n');
  await page.locator('.md-editor').click();
  await page.keyboard.press(`${MOD}+z`);
  await expect.poll(() => editorValue(page)).toBe('# Rewritten elsewhere\n');
});

test('beh.files.single-instance: Single instance: opening files from Finder reuses the running app', async ({ page }) => {
  // Finder / CLI / second-instance argv arrive as open-files in the running window.
  await openFiles(page, [`${ROOT}/Ideas/Roadmap.md`, `${ROOT}/notes.txt`]);
  await expect(tabs(page)).toHaveCount(3);
  await expect(page.locator('.title-text')).toHaveText('notes');
  // Already open: focused, not reopened.
  await openFiles(page, [`${ROOT}/Welcome.md`]);
  await expect(tabs(page)).toHaveCount(3);
  await expect(page.locator('.title-text')).toHaveText('Welcome');
  // A pristine untitled window is reused instead of adding a tab.
  await page.keyboard.press(`${MOD}+w`);
  await page.keyboard.press(`${MOD}+w`);
  await page.keyboard.press(`${MOD}+w`);
  await expect(page.locator('.title-text')).toHaveText('Untitled');
  await openFiles(page, [`${ROOT}/Ideas/Roadmap.md`]);
  await expect(page.locator('.title-text')).toHaveText('Roadmap');
  await expect(page.locator('.tab-bar')).toBeHidden();
});

const web = (page: Page) => page.evaluate(() => window.__MARGIN_WEB__!);
const toastText = (page: Page) => page.locator('.toast').last();

test('menu.file.duplicate: File › Duplicate', async ({ page }) => {
  const original = await editorValue(page);
  await menu(page, 'duplicate');
  await expect(tabs(page)).toHaveCount(2);
  await expect(page.locator('.title-text')).toHaveText('Untitled');
  await expect.poll(() => editorValue(page)).toBe(original);
  await expect.poll(() => isDirty(page)).toBe(true);
  // Saving the copy writes a new file; the original stays untouched and clean.
  await queueDialog(page, `${ROOT}/Welcome copy.md`);
  await page.keyboard.press(`${MOD}+s`);
  await expect(page.locator('.title-text')).toHaveText('Welcome copy');
  expect(await diskFile(page, `${ROOT}/Welcome copy.md`)).toBe(original);
  await tabs(page).first().click();
  await expect.poll(() => isDirty(page)).toBe(false);
  expect(await diskFile(page, `${ROOT}/Welcome.md`)).toBe(original);
});

test('menu.file.rename-move: File › Rename… / Move To… for the current document', async ({ page }) => {
  const text = await diskFile(page, `${ROOT}/Welcome.md`);
  await menu(page, 'renameFile');
  const input = page.locator('.dialog .text-input');
  await expect(input).toHaveValue('Welcome.md');
  // A path is not a name: Rename refuses and points to Move To.
  await input.fill('Ideas/Hello.md');
  await page.keyboard.press('Enter');
  await expect(page.locator('.dialog-error')).toContainText('Move To');
  await input.fill('Hello.md');
  await page.keyboard.press('Enter');
  await expect(page.locator('.title-text')).toHaveText('Hello');
  expect(await diskFile(page, `${ROOT}/Welcome.md`)).toBeUndefined();
  expect(await diskFile(page, `${ROOT}/Hello.md`)).toBe(text);
  await expect(page.locator(`.file-tree [data-path="${ROOT}/Hello.md"]`)).toHaveClass(/active/);
  // An existing target is never overwritten.
  await queueDialog(page, `${ROOT}/notes.txt`);
  await menu(page, 'moveTo');
  await expect(toastText(page)).toContainText('already exists');
  expect(await page.evaluate(() => window.__margin!.doc.path)).toBe(`${ROOT}/Hello.md`);
  // Move To another folder; the open document follows.
  await queueDialog(page, `${ROOT}/Journal/Hello.md`);
  await menu(page, 'moveTo');
  await expect.poll(() => page.evaluate(() => window.__margin!.doc.path)).toBe(`${ROOT}/Journal/Hello.md`);
  expect(await diskFile(page, `${ROOT}/Journal/Hello.md`)).toBe(text);
  expect(await diskFile(page, `${ROOT}/Hello.md`)).toBeUndefined();
});

test('menu.file.revert-versions: File › Revert To / Browse All Versions (version history)', async ({ page }) => {
  const path = `${ROOT}/Welcome.md`;
  const original = await editorValue(page);
  await typeInEditor(page, '\nfirst edit');
  await page.keyboard.press(`${MOD}+s`);
  await typeInEditor(page, '\nsecond edit');
  await page.keyboard.press(`${MOD}+s`);
  await expect.poll(() => page.evaluate((p) => window.__margin!.versions.list(p).then((l) => l.length), path)).toBe(3);
  // Revert to Saved discards unsaved edits as one undoable step.
  await typeInEditor(page, '\nunsaved');
  await menu(page, 'reloadFromDisk');
  await page.locator('.dialog [data-id=reload]').click();
  await expect.poll(() => editorValue(page)).not.toContain('unsaved');
  await page.keyboard.press(`${MOD}+z`);
  await expect.poll(() => editorValue(page)).toContain('unsaved');
  // Browse All Versions: newest first; restoring the oldest is undoable too.
  await menu(page, 'browseVersions');
  const items = page.locator('.versions-item');
  await expect(items).toHaveCount(3);
  await expect(items.first()).toHaveAttribute('aria-selected', 'true');
  await items.last().click();
  await expect(page.locator('.versions-preview')).toContainText('second edit');
  await page.locator('.versions [data-id=restore]').click();
  await expect.poll(() => editorValue(page)).toBe(original);
  await expect.poll(() => isDirty(page)).toBe(true);
  await page.locator('.md-editor').click();
  await page.keyboard.press(`${MOD}+z`);
  await expect.poll(() => editorValue(page)).toContain('second edit');
  // Untitled documents have no history yet.
  await page.keyboard.press(`${MOD}+t`);
  await menu(page, 'browseVersions');
  await expect(toastText(page)).toContainText('Save the document first');
});

// GBK bytes of "# 中文测试，你好"
const GBK = [0x23, 0x20, 0xd6, 0xd0, 0xce, 0xc4, 0xb2, 0xe2, 0xca, 0xd4, 0xa3, 0xac, 0xc4, 0xe3, 0xba, 0xc3];

test('menu.file.encoding: File › Reopen with Encoding', async ({ page }) => {
  await page.evaluate(({ p, b }) => window.__MARGIN_WEB__!.externalWriteBytes(p, b), { p: `${ROOT}/gbk.md`, b: GBK });
  await openFiles(page, [`${ROOT}/gbk.md`]);
  // Auto-detected on open, with a note that saving writes UTF-8.
  await expect.poll(() => editorValue(page)).toBe('# 中文测试，你好');
  await expect(page.locator('.toast', { hasText: 'Chinese Simplified' })).toBeVisible();
  await expect.poll(() => page.evaluate(() => window.__margin!.doc.encoding)).toBe('gb18030');
  // Reopen as Latin-1 on purpose (mojibake), then back with auto-detect.
  await menu(page, 'reopenWithEncoding');
  await page.locator('.palette-input').fill('Latin 1');
  await page.keyboard.press('Enter');
  await expect.poll(() => editorValue(page)).toContain('ÖÐ');
  await menu(page, 'reopenWithEncoding');
  await page.locator('.palette-input').fill('Auto');
  await page.keyboard.press('Enter');
  await expect.poll(() => editorValue(page)).toBe('# 中文测试，你好');
  // Saving converts the file to UTF-8.
  await typeInEditor(page, '!');
  await page.keyboard.press(`${MOD}+s`);
  expect(await diskFile(page, `${ROOT}/gbk.md`)).toBe('# 中文测试，你好!');
  await expect.poll(() => page.evaluate(() => window.__margin!.doc.encoding)).toBe('utf-8');
  // Untitled: nothing to reopen.
  await page.keyboard.press(`${MOD}+t`);
  await menu(page, 'reopenWithEncoding');
  await expect(toastText(page)).toContainText('Save the document first');
});

test('menu.file.reveal: File › Reveal in Finder / Open File Location / Copy File Path (current doc)', async ({ page }) => {
  await menu(page, 'revealInFinder');
  await expect.poll(() => page.evaluate(() => window.__MARGIN_WEB__!.revealed.at(-1))).toBe(`${ROOT}/Welcome.md`);
  await menu(page, 'copyFilePath');
  await expect.poll(() => page.evaluate(() => window.__MARGIN_WEB__!.clipboardText)).toBe(`${ROOT}/Welcome.md`);
  await expect(toastText(page)).toContainText('File path copied');
  await page.keyboard.press(`${MOD}+t`);
  await menu(page, 'copyFilePath');
  await expect(toastText(page)).toContainText('Save the document first');
  expect(await page.evaluate(() => window.__MARGIN_WEB__!.clipboardText)).toBe(`${ROOT}/Welcome.md`);
});

test('menu.file.errors: Open/save error reporting (missing file, open failed, create prompt)', async ({ page }) => {
  const missing = `${ROOT}/Gone.md`;
  await page.evaluate((p) => window.__margin!.updateSettings({ recentFiles: [p] }), missing);
  // Missing file: offer to create it; Cancel opens nothing and drops it from Open Recent.
  void page.evaluate((p) => window.__margin!.docs.openPath(p, 'tab'), missing);
  const dialog = page.locator('.dialog');
  await expect(dialog).toContainText('File does not exist at');
  await dialog.locator('[data-id=cancel]').click();
  await expect(page.locator('.title-text')).toHaveText('Welcome');
  await expect(page.locator('.tab-bar')).toBeHidden();
  await expect.poll(() => page.evaluate(() => window.__margin!.settings.recentFiles)).toEqual([]);
  // Create makes an empty file there and opens it.
  void page.evaluate((p) => window.__margin!.docs.openPath(p, 'tab'), missing);
  await dialog.locator('[data-id=create]').click();
  await expect(page.locator('.title-text')).toHaveText('Gone');
  expect(await diskFile(page, missing)).toBe('');
  // A folder is not a document.
  await page.evaluate((p) => window.__margin!.docs.openPath(p, 'tab'), `${ROOT}/Ideas`);
  await expect(toastText(page)).toContainText('Open Failed');
});

test('beh.files.external-merge: External change prompt offers Keep mine / Load disk / Show diff', async ({ page }) => {
  await typeInEditor(page, '\nmine');
  await page.evaluate((p) => window.__MARGIN_WEB__!.externalWrite(p, '# Theirs\n'), `${ROOT}/Welcome.md`);
  const banner = page.locator('.extchange-banner');
  await expect(banner).toBeVisible();
  await expect(banner.locator('[data-id=keep]')).toHaveText('Keep Mine');
  await expect(banner.locator('[data-id=load]')).toHaveText('Load Disk');
  await banner.locator('[data-id=diff]').click();
  await expect(page.locator('.extdiff-body')).toContainText('Theirs');
  await page.locator('.extdiff [data-id=keep]').click();
  await expect(banner).toBeHidden();
  await expect.poll(() => editorValue(page)).toContain('mine');
  // The banner follows its tab: another document shows none.
  await page.keyboard.press(`${MOD}+t`);
  await expect(banner).toBeHidden();
});

test('menu.file.properties: File › Properties / Get Info (word count, size, dates)', async ({ page }) => {
  await menu(page, 'properties');
  const props = page.locator('.file-properties');
  await expect(props.locator('[data-prop=name]')).toHaveText('Welcome.md');
  await expect(props.locator('[data-prop=location]')).toContainText('Notes');
  await expect(props.locator('[data-prop=size]')).toContainText(/bytes|KB/);
  await expect(props.locator('[data-prop=words]')).not.toHaveText('0');
  await expect(props.locator('[data-prop=encoding]')).toContainText('UTF-8');
  await props.locator('.btn-primary').click();
  await page.keyboard.press(`${MOD}+t`);
  await menu(page, 'properties');
  await expect(props.locator('[data-prop=location]')).toHaveText('Not saved');
  await expect(props.locator('[data-prop=size]')).toHaveText('—');
});

test('beh.core.large-file: Oversize documents: degrade gracefully (warn / source mode)', async ({ page }) => {
  await page.evaluate(() => window.__margin!.updateSettings({ largeFileBytes: 4000 }));
  const big = `# Big\n\n${'Lorem ipsum dolor sit amet. '.repeat(200)}\n`;
  await page.evaluate(({ p, t }) => window.__MARGIN_WEB__!.externalWrite(p, t), { p: `${ROOT}/Big.md`, t: big });
  await openFiles(page, [`${ROOT}/Big.md`]);
  await expect(page.locator('.toast', { hasText: 'large' })).toBeVisible();
  await expect.poll(() => page.evaluate(() => window.__margin!.editor.isSourceMode())).toBe(true);
  await expect.poll(() => editorValue(page)).toBe(big);
  // Normal documents keep the WYSIWYG view.
  await tabs(page).first().click();
  await expect.poll(() => page.evaluate(() => window.__margin!.editor.isSourceMode())).toBe(false);
});

test('pref.general.save: General: Auto Save, save-on-switch, recover unsaved drafts', async ({ page }) => {
  // Save without asking when switching files.
  await page.keyboard.press(`${MOD}+Comma`);
  await page.locator('.pref-nav [data-section=files]').click();
  await page.locator('input[data-pref=saveOnSwitch]').check();
  await page.keyboard.press('Escape');
  await typeInEditor(page, '\nsaved on switch');
  await page.locator(`.file-tree [data-path="${ROOT}/notes.txt"]`).click();
  await expect(page.locator('.title-text')).toHaveText('notes');
  await expect(page.locator('.dialog')).toHaveCount(0);
  expect(await diskFile(page, `${ROOT}/Welcome.md`)).toContain('saved on switch');

  // Drafts survive a crash (reload without closing) and can be recovered.
  await page.keyboard.press(`${MOD}+t`);
  await page.keyboard.type('# Crash draft');
  await expect.poll(() => diskFile(page, '/drafts/main.json'), { timeout: 5000 }).toContain('Crash draft');
  await page.reload();
  await expect(page.locator('.app.ready')).toBeVisible();
  await page.locator('.toast', { hasText: 'unsaved draft' }).locator('.toast-action').click();
  await expect(page.locator('.palette-item').first()).toContainText('Untitled');
  await page.keyboard.press('Enter');
  await expect.poll(() => editorValue(page)).toBe('# Crash draft');
  await expect.poll(() => isDirty(page)).toBe(true);
  // A clean close leaves nothing to recover.
  await page.keyboard.press(`${MOD}+w`);
  await page.locator('.dialog [data-id=discard]').click();
  expect(await page.evaluate(() => window.__MARGIN_WEB__!.requestClose())).toBe(true);
  expect(await diskFile(page, '/drafts/main.json')).toBe('[]');
});

const dropFiles = (page: Page, paths: string[], x: number, y: number) =>
  page.evaluate(([p, px, py]) => window.__MARGIN_WEB__!.dropFiles(p as string[], px as number, py as number), [paths, x, y] as const);

test('beh.files.drop: Drop files from the OS: open Markdown/folders, insert images and links', async ({ page }) => {
  await page.evaluate(async (root) => {
    const p = window.__margin!.platform;
    await p.writeTextFile(`${root}/Pics/cat photo.png`, 'png-bytes');
    await p.writeTextFile(`${root}/spec.pdf`, 'pdf-bytes');
  }, ROOT);

  // Over the editor: the image is stored by the image rule and inserted, the PDF becomes a
  // relative link; both land at the drop point (end of the quote line), in drop order.
  const quote = page.locator('.md-editor', { hasText: 'Simplicity' }).getByText('Simplicity is the ultimate sophistication.');
  const box = (await quote.boundingBox())!;
  await dropFiles(page, [`${ROOT}/Pics/cat photo.png`, `${ROOT}/spec.pdf`, `${ROOT}/missing.png`], box.x + box.width - 1, box.y + box.height / 2);
  await expect.poll(() => editorValue(page)).toContain('sophistication.![cat photo](assets/cat%20photo.png) [spec.pdf](spec.pdf)');
  expect(await page.evaluate((r) => window.__margin!.platform.stat(`${r}/assets/cat photo.png`).then(Boolean, () => false), ROOT)).toBe(true);
  // One undo removes the whole drop.
  await page.keyboard.press(`${MOD}+z`);
  await expect.poll(() => editorValue(page)).not.toContain('spec.pdf');

  // Markdown files open as a tab wherever they are dropped; already-open ones are focused.
  await dropFiles(page, [`${ROOT}/Ideas/Roadmap.md`], box.x + 5, box.y + 5);
  await expect(page.locator('.title-text')).toHaveText('Roadmap');
  await expect(tabs(page)).toHaveCount(2);
  await dropFiles(page, [`${ROOT}/Ideas/Roadmap.md`], 2, 2);
  await expect(tabs(page)).toHaveCount(2);
  expect(await editorValue(page)).not.toContain('Roadmap.md');

  // Non-Markdown files outside the editor are not opened.
  await dropFiles(page, [`${ROOT}/spec.pdf`], 2, 2);
  await expect(page.locator('.toast').last()).toContainText('only Markdown files and folders can be opened');
  await expect(tabs(page)).toHaveCount(2);

  // A folder opens in the sidebar.
  await dropFiles(page, [`${ROOT}/Journal`], 2, 2);
  await expect(page.locator(`.file-tree [data-path="${ROOT}/Journal/2026-10-17.md"]`)).toBeVisible();
});

test('pref.general.launch: General: On Launch (restore files/folders, open new file, default folder)', async ({ page }) => {
  // Labels and default.
  await menu(page, 'preferences');
  await page.locator('.pref-nav [data-section=files]').click();
  const sel = page.locator('select[data-pref="onLaunch"]');
  await expect(sel.locator('option')).toHaveText(['Open new file', 'Restore last closed folders', 'Restore last closed files and folders', 'Open custom folder']);
  await expect(sel).toHaveValue('restoreFolders');
  await page.keyboard.press('Escape');

  // Restore last closed files and folders: the tabs open at the last clean close come back.
  await openFiles(page, [`${ROOT}/Ideas/Roadmap.md`]);
  await expect(tabs(page)).toHaveCount(2);
  await page.evaluate(() => window.__margin!.updateSettings({ onLaunch: 'restoreFilesAndFolders' }));
  expect(await page.evaluate(() => window.__MARGIN_WEB__!.requestClose())).toBe(true);
  await page.goto(`/?folder=${encodeURIComponent(ROOT)}&open=`);
  await expect(page.locator('.app.ready')).toBeVisible();
  await expect(tabs(page)).toHaveText([/Welcome/, /Roadmap/]);

  // Open custom folder: the pinned folder is mounted instead of the last one.
  await page.evaluate((r) => window.__margin!.updateSettings({ onLaunch: 'customFolder', pinFolder: `${r}/Journal` }), ROOT);
  expect(await page.evaluate(() => window.__MARGIN_WEB__!.requestClose())).toBe(true);
  await page.goto('/?open=');
  await expect(page.locator('.app.ready')).toBeVisible();
  await expect(page.locator(`.file-tree [data-path="${ROOT}/Journal/2026-10-17.md"]`)).toBeVisible();
  await expect(page.locator('.tab-bar')).toBeHidden(); // one blank document: no tab bar
});

test('sidebar Duplicate names copies "X (copy).ext", "X (copy) (copy).ext"', async ({ page }) => {
  await page.locator(`.file-tree [data-path="${ROOT}/Ideas"]`).click();
  for (const expected of ['Roadmap (copy).md', 'Roadmap (copy) (copy).md']) {
    await page.locator(`.file-tree [data-path="${ROOT}/Ideas/Roadmap.md"]`).click({ button: 'right' });
    await page.locator('.context-item', { hasText: /^Duplicate$/ }).click();
    await expect(page.locator(`.file-tree [data-path="${ROOT}/Ideas/${expected}"]`)).toBeVisible();
    expect(await diskFile(page, `${ROOT}/Ideas/${expected}`)).toBe(await diskFile(page, `${ROOT}/Ideas/Roadmap.md`));
  }
  // The open document is untouched.
  await expect(page.locator('.title-text')).toHaveText('Welcome');
});
