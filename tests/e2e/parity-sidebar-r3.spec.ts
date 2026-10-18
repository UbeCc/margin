import { expect, test, type Page } from '@playwright/test';
import { boot, diskFile, editorValue, ROOT } from './app-helpers';

test.beforeEach(async ({ page }) => boot(page));

const tree = (page: Page) => page.locator('.file-tree');
const row = (page: Page, path: string) => tree(page).locator(`.tree-row[data-path="${path}"]`);
const modalTitle = (page: Page) => page.locator('.modal-card .dialog-title');
const menu = (page: Page, id: string): Promise<boolean> =>
  page.evaluate((a) => window.__margin!.run(a as Parameters<NonNullable<typeof window.__margin>['run']>[0]), id);

test('sidebar.move-confirm: "Are you sure you want to move %@?" suppressible; Undo Move (#131)', async ({ page }) => {
  const notes = row(page, `${ROOT}/notes.txt`);
  const journal = row(page, `${ROOT}/Journal`);
  // Cancel keeps the file at the root.
  await notes.dragTo(journal);
  await expect(modalTitle(page)).toHaveText('Are you sure you want to move notes.txt?');
  await page.locator('.modal-card button[data-id=cancel]').click();
  await expect(notes).toBeVisible();
  await expect(row(page, `${ROOT}/Journal/notes.txt`)).toHaveCount(0);
  // Move proceeds after confirming.
  await notes.dragTo(journal);
  await page.locator('.modal-card button[data-id=move]').click();
  await expect(row(page, `${ROOT}/Journal/notes.txt`)).toBeVisible();
  await expect(notes).toHaveCount(0);
  await expect.poll(() => diskFile(page, `${ROOT}/Journal/notes.txt`)).toContain('plain text notes');
  // Undo Move from the moved file's context menu puts it back.
  await row(page, `${ROOT}/Journal/notes.txt`).click({ button: 'right' });
  await page.locator('.context-menu .context-item', { hasText: 'Undo Move notes.txt' }).click();
  await expect(notes).toBeVisible();
  await expect(row(page, `${ROOT}/Journal/notes.txt`)).toHaveCount(0);
  // "Do not ask again" suppresses the confirmation for later moves.
  await notes.dragTo(journal);
  await page.locator('.dialog-checkbox input').check();
  await page.locator('.modal-card button[data-id=move]').click();
  await expect(row(page, `${ROOT}/Journal/notes.txt`)).toBeVisible();
  await expect.poll(() => page.evaluate(() => window.__margin!.settings.confirmSidebarMove)).toBe(false);
  await row(page, `${ROOT}/Journal/notes.txt`).click({ button: 'right' });
  await page.locator('.context-menu .context-item', { hasText: 'Undo Move notes.txt' }).click();
  await expect(notes).toBeVisible();
  await notes.dragTo(journal);
  await expect(modalTitle(page)).toHaveCount(0); // no dialog: suppressed
  await expect(row(page, `${ROOT}/Journal/notes.txt`)).toBeVisible();
});

test('sidebar.undo-rename: "Undo Rename %@" in the context menu (#131)', async ({ page }) => {
  const notes = row(page, `${ROOT}/notes.txt`);
  await notes.click({ button: 'right' });
  await page.locator('.context-menu .context-item', { hasText: 'Rename…' }).click();
  await page.locator('.modal-card input.text-input').fill('todo.txt');
  await page.locator('.modal-card button[type=submit]').click();
  await expect(row(page, `${ROOT}/todo.txt`)).toBeVisible();
  await expect(notes).toHaveCount(0);
  // Undo Rename leads the menu.
  await row(page, `${ROOT}/todo.txt`).click({ button: 'right' });
  await page.locator('.context-menu .context-item', { hasText: 'Undo Rename todo.txt' }).click();
  await expect(notes).toBeVisible();
  await expect(row(page, `${ROOT}/todo.txt`)).toHaveCount(0);
});

test('sidebar.quicklook: Quick Look in tree/list menus and Space on a focused row (#131)', async ({ page }) => {
  const notes = row(page, `${ROOT}/notes.txt`);
  await notes.click({ button: 'right' });
  await expect(page.locator('.context-menu .context-item', { hasText: 'Quick Look' })).toBeVisible();
  await page.locator('.context-menu .context-item', { hasText: 'Quick Look' }).click();
  await expect.poll(() => page.evaluate(() => window.__MARGIN_WEB__!.quickLooked)).toEqual([`${ROOT}/notes.txt`]);
  // Space on the focused row previews it (Finder-style).
  await notes.click(); // opens the file and focuses its row
  await page.keyboard.press(' ');
  await expect.poll(() => page.evaluate(() => window.__MARGIN_WEB__!.quickLooked)).toEqual([`${ROOT}/notes.txt`, `${ROOT}/notes.txt`]);
  // Articles list menu has it too.
  await tree(page).hover();
  await tree(page).locator('.tree-actions [aria-label="Switch File List/Tree View"]').click();
  await tree(page).locator('.list-item', { hasText: 'Roadmap' }).click({ button: 'right' });
  await page.locator('.context-menu .context-item', { hasText: 'Quick Look' }).click();
  await expect.poll(() => page.evaluate(() => window.__MARGIN_WEB__!.quickLooked)).toEqual([
    `${ROOT}/notes.txt`,
    `${ROOT}/notes.txt`,
    `${ROOT}/Ideas/Roadmap.md`,
  ]);
});

test('sidebar.outline-pin: unpin hides the sidebar for a drop-down outline; pin restores (#131)', async ({ page }) => {
  await page.locator('.sidebar-tab[data-tab=outline]').click();
  const pin = page.locator('.outline-pin');
  await expect(pin).toHaveAttribute('title', 'Unpin Outline');
  await expect(page.locator('.outline .outline-item')).toHaveCount(5); // Welcome headings
  // Unpin: sidebar hides, the drop-down outline appears with the same rows.
  await pin.click();
  await expect(page.locator('.sidebar')).toHaveAttribute('aria-hidden', 'true');
  const dd = page.locator('.outline-dropdown');
  await expect(dd).toBeVisible();
  await expect(dd.locator('.outline-pin')).toHaveAttribute('title', 'Pin Outline');
  await expect(dd.locator('.outline-item')).toHaveCount(5);
  // Escape closes the drop-down; View ▸ Outline reopens it (no sidebar while unpinned).
  await page.keyboard.press('Escape');
  await expect(dd).toHaveCount(0);
  await menu(page, 'showOutline');
  await expect(page.locator('.outline-dropdown')).toBeVisible();
  await expect(page.locator('.sidebar')).toHaveAttribute('aria-hidden', 'true');
  // Pin: back to the sidebar Outline tab, drop-down gone.
  await page.locator('.outline-dropdown .outline-pin').click();
  await expect(page.locator('.outline-dropdown')).toHaveCount(0);
  await expect(page.locator('.sidebar')).toHaveAttribute('aria-hidden', 'false');
  await expect(page.locator('.sidebar-panel[data-panel=outline]')).toBeVisible();
  await expect(page.locator('.sidebar-panel[data-panel=outline] .outline-item')).toHaveCount(5);
  await expect.poll(() => page.evaluate(() => window.__margin!.settings.outlinePinned)).toBe(true);
  // Sanity: the editor is still the welcome doc.
  await expect.poll(() => editorValue(page)).toContain('# Welcome to Margin');
});
