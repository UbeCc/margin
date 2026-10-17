import { expect, test } from '@playwright/test';
import { boot, editorValue, MOD, queueDialog, ROOT, diskFile, typeInEditor } from './app-helpers';

test.beforeEach(async ({ page }) => boot(page));

test('file tree lazily expands folders and opens files', async ({ page }) => {
  const tree = page.locator('.file-tree');
  await expect(tree.locator('.tree-title')).toHaveText('Notes');
  await expect(tree.locator('.tree-row.active')).toHaveAttribute('data-path', `${ROOT}/Welcome.md`);
  await expect(tree.locator(`[data-path="${ROOT}/Ideas/Roadmap.md"]`)).toHaveCount(0);
  await tree.locator(`[data-path="${ROOT}/Ideas"]`).click();
  await tree.locator(`[data-path="${ROOT}/Ideas/Roadmap.md"]`).click();
  await expect.poll(() => editorValue(page)).toContain('# Roadmap');
  await expect(page.locator('.title-text')).toHaveText('Roadmap');
  await expect(tree.locator('.tree-row.active')).toHaveAttribute('data-path', `${ROOT}/Ideas/Roadmap.md`);
});

test('editing marks dirty, Cmd+S saves to disk', async ({ page }) => {
  await typeInEditor(page, '\nA new line.');
  await expect(page.locator('.app')).toHaveClass(/doc-dirty/);
  await expect.poll(() => page.evaluate(() => window.__MARGIN_WEB__!.documentEdited)).toBe(true);
  await expect.poll(() => page.evaluate(() => document.title)).toMatch(/^• Welcome\.md/);
  await page.keyboard.press(`${MOD}+s`);
  await expect(page.locator('.app')).not.toHaveClass(/doc-dirty/);
  expect(await diskFile(page, `${ROOT}/Welcome.md`)).toContain('A new line.');
  await expect(page.locator('.status-save')).toHaveText('Saved');
});

test('new untitled document → Save As writes file and shows it in the tree', async ({ page }) => {
  await page.keyboard.press(`${MOD}+n`);
  await expect(page.locator('.title-text')).toHaveText('Untitled');
  await typeInEditor(page, '# Fresh idea');
  await queueDialog(page, `${ROOT}/Fresh idea.md`);
  await page.keyboard.press(`${MOD}+s`);
  await expect(page.locator('.title-text')).toHaveText('Fresh idea');
  expect(await diskFile(page, `${ROOT}/Fresh idea.md`)).toBe('# Fresh idea');
  await expect(page.locator(`.tree-row[data-path="${ROOT}/Fresh idea.md"]`)).toHaveClass(/active/);
});

test('switching away from unsaved changes asks; Don’t Save discards', async ({ page }) => {
  await typeInEditor(page, 'unsaved');
  await page.locator(`[data-path="${ROOT}/notes.txt"]`).click();
  const dialog = page.locator('.dialog');
  await expect(dialog).toContainText('Do you want to save the changes');
  await dialog.locator('[data-id=cancel]').click();
  await expect(page.locator('.title-text')).toHaveText('Welcome');
  await page.locator(`[data-path="${ROOT}/notes.txt"]`).click();
  await page.locator('.dialog [data-id=discard]').click();
  await expect(page.locator('.title-text')).toHaveText('notes');
  expect(await diskFile(page, `${ROOT}/Welcome.md`)).not.toContain('unsaved');
  // CRLF file shows CRLF in the status bar
  await expect(page.locator('.statusbar .eol')).toHaveText('CRLF');
});

test('external change reloads silently when clean and prompts when dirty', async ({ page }) => {
  await page.evaluate((p) => window.__MARGIN_WEB__!.externalWrite(p, '# Changed elsewhere\n'), `${ROOT}/Welcome.md`);
  await expect.poll(() => editorValue(page)).toBe('# Changed elsewhere\n');
  await typeInEditor(page, 'mine');
  await page.evaluate((p) => window.__MARGIN_WEB__!.externalWrite(p, '# Again\n'), `${ROOT}/Welcome.md`);
  const dialog = page.locator('.dialog');
  await expect(dialog).toContainText('changed by another application');
  await dialog.locator('[data-id=reload]').click();
  await expect.poll(() => editorValue(page)).toBe('# Again\n');
});

test('close request with unsaved changes can be cancelled', async ({ page }) => {
  await typeInEditor(page, 'x');
  const result = page.evaluate(() => window.__MARGIN_WEB__!.requestClose());
  await page.locator('.dialog [data-id=cancel]').click();
  expect(await result).toBe(false);
});

test('context menu: new file, rename (open doc follows), new folder, trash', async ({ page }) => {
  await page.locator(`[data-path="${ROOT}/Journal"]`).click({ button: 'right' });
  await page.locator('.context-item', { hasText: 'New File' }).click();
  const input = page.locator('.dialog .text-input');
  await expect(input).toHaveValue('Untitled.md');
  await input.fill('Saturday');
  await page.keyboard.press('Enter');
  await expect(page.locator('.title-text')).toHaveText('Saturday');
  expect(await diskFile(page, `${ROOT}/Journal/Saturday.md`)).toBe('');

  // Rename keeps the open document attached to the file.
  await page.locator(`[data-path="${ROOT}/Journal/Saturday.md"]`).click({ button: 'right' });
  await page.locator('.context-item', { hasText: 'Rename' }).click();
  await page.locator('.dialog .text-input').fill('Sunday.md');
  await page.keyboard.press('Enter');
  await expect(page.locator(`.tree-row[data-path="${ROOT}/Journal/Sunday.md"]`)).toHaveClass(/active/);
  await expect(page.locator('.title-text')).toHaveText('Sunday');
  expect(await diskFile(page, `${ROOT}/Journal/Saturday.md`)).toBeUndefined();
  await typeInEditor(page, 'renamed ok');
  await page.keyboard.press(`${MOD}+s`);
  await expect.poll(() => diskFile(page, `${ROOT}/Journal/Sunday.md`)).toContain('renamed ok');
  expect(await diskFile(page, `${ROOT}/Journal/Saturday.md`)).toBeUndefined();

  // Rename onto an existing name is refused with an error toast.
  await page.locator(`[data-path="${ROOT}/Journal/Sunday.md"]`).click({ button: 'right' });
  await page.locator('.context-item', { hasText: 'Rename' }).click();
  await page.locator('.dialog .text-input').fill('2026-10-17.md');
  await page.keyboard.press('Enter');
  await expect(page.locator('.toast').last()).toContainText("Couldn't rename");

  // New folder, then trash it.
  await page.locator(`[data-path="${ROOT}/Journal"]`).click({ button: 'right' });
  await page.locator('.context-item', { hasText: 'New Folder' }).click();
  await page.locator('.dialog .text-input').fill('Drafts');
  await page.keyboard.press('Enter');
  const drafts = page.locator(`.tree-row[data-path="${ROOT}/Journal/Drafts"]`);
  await expect(drafts).toBeVisible();
  await drafts.click({ button: 'right' });
  await page.locator('.context-item', { hasText: 'Move to Trash' }).click();
  await page.locator('.dialog [data-id=ok]').click();
  await expect(drafts).toHaveCount(0);
});
