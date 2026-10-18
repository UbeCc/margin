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
  // The new window starts empty: no folder restored, nothing to save.
  await expect(win.locator('.file-tree .tree-title')).toHaveCount(0);
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
