import { expect, test, type Page } from '@playwright/test';
import { boot, editorValue, MOD, ROOT } from './app-helpers';

test.beforeEach(async ({ page }) => boot(page));

const tree = (page: Page) => page.locator('.file-tree');
const fileRows = (page: Page) => tree(page).locator('.tree-root > li > .tree-row[data-kind=file]');
const menuItem = (page: Page, name: string) => page.locator('.context-menu').getByRole('menuitemcheckbox', { name });

async function headerButton(page: Page, label: string) {
  await tree(page).hover();
  return tree(page).locator(`.tree-actions [aria-label="${label}"]`);
}

test('sidebar.sort: File tree sorting (name/natural/created/modified, asc/desc)', async ({ page }) => {
  // Two top-level files; give notes.txt the newer mtime.
  await page.evaluate((root) => window.__MARGIN_WEB__!.writeTextFile(`${root}/notes.txt`, 'newer'), ROOT);
  await expect(fileRows(page)).toHaveText(['notes.txt', 'Welcome.md']); // natural, ascending (default)
  await (await headerButton(page, 'Sort')).click();
  await expect(page.locator('.context-menu [role=menuitemcheckbox]')).toHaveCount(8);
  await expect(menuItem(page, 'Sort Naturally (Ascending)')).toHaveAttribute('aria-checked', 'true');
  await menuItem(page, 'Sort by Name (Descending)').click();
  await expect(fileRows(page)).toHaveText(['Welcome.md', 'notes.txt']);
  // Folders stay first whatever the order.
  await expect(tree(page).locator('.tree-root > li > .tree-row').first()).toHaveAttribute('data-kind', 'dir');
  await (await headerButton(page, 'Sort')).click();
  await menuItem(page, 'Sort by Modification Date (Descending)').click();
  await expect(fileRows(page)).toHaveText(['notes.txt', 'Welcome.md']);
  await (await headerButton(page, 'Sort')).click();
  await menuItem(page, 'Sort by Modification Date (Ascending)').click();
  await expect(fileRows(page)).toHaveText(['Welcome.md', 'notes.txt']);
  // Persisted: survives a reload.
  await expect.poll(() => page.evaluate(() => window.__margin!.settings.sidebarSort)).toBe('modified-asc');
});

test('sidebar.list-view: Articles list view (summaries, ≤400 items) and tree/list switch', async ({ page }) => {
  await (await headerButton(page, 'Switch File List/Tree View')).click();
  await expect(tree(page)).toHaveAttribute('data-mode', 'list');
  const items = page.locator('.file-list .list-item');
  await expect(items).toHaveCount(6); // every document in every folder; images/hidden excluded
  const roadmap = items.filter({ hasText: 'Roadmap' });
  await expect(roadmap.locator('.list-summary')).toHaveText(/Roadmap Q4 Export to PDF/);
  await expect(roadmap.locator('.list-meta')).toContainText('Ideas');
  await expect(items.filter({ hasText: 'Welcome' })).toHaveClass(/active/);
  await roadmap.click();
  await expect.poll(() => editorValue(page)).toContain('# Roadmap');
  // Group By Folder (from the sort menu in list view).
  await (await headerButton(page, 'Sort')).click();
  await menuItem(page, 'Group By Folder').click();
  await expect(page.locator('.file-list .list-group')).toHaveText(['Notes', 'Ideas', 'Journal']);
  // Command: Articles toggles; switch back to the tree.
  await (await headerButton(page, 'Switch File List/Tree View')).click();
  await expect(tree(page)).toHaveAttribute('data-mode', 'tree');
  await expect(tree(page).locator('.tree-body')).toBeVisible();
  await page.keyboard.press(`${MOD}+Shift+2`);
  await expect(tree(page)).toHaveAttribute('data-mode', 'list');
});

test('sidebar.search: Sidebar full-text search across the folder', async ({ page }) => {
  await page.keyboard.press(`${MOD}+Shift+f`);
  await expect(tree(page)).toHaveAttribute('data-mode', 'search');
  const input = page.locator('.sidebar-search-input');
  await expect(input).toBeFocused();
  await input.fill('SIDEBAR'); // case-insensitive by default
  const groups = page.locator('.search-group');
  await expect(groups).toHaveCount(2);
  await expect(groups.locator('.search-line mark')).toHaveText(['sidebar', 'sidebar']);
  await page.locator('.search-case').click(); // Match Case
  await expect(page.locator('.search-status')).toHaveText('No Results');
  await page.locator('.search-case').click();
  await input.fill('Sketched');
  await expect(groups).toHaveCount(1);
  await expect(groups.first()).toHaveAttribute('data-path', `${ROOT}/Journal/2026-10-16.md`);
  // File-name matches get their own section.
  await input.fill('roadmap');
  await expect(page.locator('.search-section-title')).toHaveText('File Results');
  await expect(page.locator('.search-section .search-file')).toHaveCount(1);
  // Negative: nothing found.
  await input.fill('zzzz-not-here');
  await expect(page.locator('.search-status')).toHaveText('No Results');
  // A content hit opens the file and selects the match in the editor.
  await input.fill('Shipped');
  await page.locator('.search-line').first().click();
  await expect.poll(() => editorValue(page)).toContain('# Friday');
  await expect.poll(() => page.evaluate(() => getSelection()!.toString())).toBe('Shipped');
  // Escape on an empty field leaves search mode.
  await input.fill('');
  await input.press('Escape');
  await expect(tree(page)).toHaveAttribute('data-mode', 'tree');
});

test('sidebar.outline-collapse: Outline: collapsible/flat outline, expand/collapse all, filter, unpin', async ({ page }) => {
  await page.locator('.sidebar-tab[data-tab=outline]').click();
  const items = page.locator('.outline-item:visible');
  await expect(items).toHaveCount(5);
  // Filter keeps matches plus ancestors.
  await page.locator('.outline-filter').fill('中文');
  await expect(items).toHaveText(['Welcome to Margin', 'Writing', '中文排版']);
  await page.locator('.outline-filter').fill('nope');
  await expect(items).toHaveCount(0);
  await expect(page.locator('.outline-nomatch')).toHaveText('No Results');
  await page.locator('.outline-filter').fill('');
  // Collapsible mode via the options menu, then collapse/expand.
  await page.locator('.outline-more').click();
  await page.locator('.context-menu').getByRole('menuitemcheckbox', { name: 'Collapsible Outline' }).click();
  await expect(page.locator('.outline')).toHaveAttribute('data-collapsible', 'true');
  await page.locator('.outline-more').click();
  await page.locator('.context-menu').getByRole('menuitem', { name: 'Collapse All' }).click();
  await expect(items).toHaveText(['Welcome to Margin']);
  await page.locator('.outline-item[aria-expanded] .outline-toggle').first().click();
  await expect(items).toHaveCount(4); // h2s visible, 中文排版 still under collapsed "Writing"
  await page.locator('.outline-more').click();
  await page.locator('.context-menu').getByRole('menuitem', { name: 'Expand All' }).click();
  await expect(items).toHaveCount(5);
  // Flat outline: no toggles; setting persisted.
  await page.locator('.outline-more').click();
  await page.locator('.context-menu').getByRole('menuitemcheckbox', { name: 'Flat Outline' }).click();
  await expect(page.locator('.outline-toggle')).toHaveCount(0);
  await expect.poll(() => page.evaluate(() => window.__margin!.settings.outlineCollapsible)).toBe(false);
});

test('sidebar.drag: Drag files from sidebar into the editor / other apps; drop files to open', async ({ page }) => {
  const ideas = tree(page).locator(`.tree-row[data-path="${ROOT}/Ideas"]`);
  await ideas.click();
  const roadmap = tree(page).locator(`.tree-row[data-path="${ROOT}/Ideas/Roadmap.md"]`);
  await expect(roadmap).toHaveAttribute('draggable', 'true');
  // Into the editor: a relative link at the drop point.
  await roadmap.dragTo(page.locator('.md-editor .md-block').last());
  await expect.poll(() => editorValue(page)).toContain('[Roadmap](Ideas/Roadmap.md)');
  // Onto a folder: move it there (open document path follows).
  await tree(page).locator(`.tree-row[data-path="${ROOT}/notes.txt"]`).dragTo(tree(page).locator(`.tree-row[data-path="${ROOT}/Journal"]`));
  await expect(tree(page).locator(`.tree-row[data-path="${ROOT}/Journal/notes.txt"]`)).toBeVisible();
  await expect(tree(page).locator(`.tree-row[data-path="${ROOT}/notes.txt"]`)).toHaveCount(0);
  // Negative: dropping a folder into itself is refused.
  await ideas.dragTo(roadmap);
  await expect(tree(page).locator(`.tree-row[data-path="${ROOT}/Ideas"]`)).toBeVisible();
});
