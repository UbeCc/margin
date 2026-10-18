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
  await expect(page.locator('.context-menu [role=menuitemcheckbox]')).toHaveCount(9); // 8 orders + Group By Folder
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
  // Group By Folder off: folders interleave with files (newest file first).
  await (await headerButton(page, 'Sort')).click();
  await menuItem(page, 'Sort by Modification Date (Descending)').click();
  await (await headerButton(page, 'Sort')).click();
  await menuItem(page, 'Group By Folder').click();
  await expect(tree(page).locator('.tree-root > li > .tree-row').first()).toHaveAttribute('data-kind', 'file');
  // Persisted.
  await expect.poll(() => page.evaluate(() => window.__margin!.settings.sidebarSort)).toBe('modified-desc');
});

test('sidebar.list-view: Articles list view (summaries, ≤400 items) and tree/list switch', async ({ page }) => {
  await (await headerButton(page, 'Switch File List/Tree View')).click();
  await expect(tree(page)).toHaveAttribute('data-mode', 'list');
  const items = page.locator('.file-list .list-item');
  await expect(items).toHaveCount(6); // every document in every folder; images/hidden excluded
  const roadmap = items.filter({ hasText: 'Roadmap' });
  await expect(roadmap.locator('.list-title')).toHaveText('Roadmap.md'); // file name, not the first heading
  await expect(roadmap.locator('.list-ext')).toHaveText('.md');
  await expect(roadmap.locator('.list-summary')).toHaveText(/Roadmap\s+Q4\s+Export to PDF/);
  await expect(roadmap.locator('.list-meta')).toHaveText('1970-01-01'); // fixture mtime
  await expect(items.filter({ hasText: 'Welcome' })).toHaveClass(/active/);
  // Group By Folder is on by default (an article lives outside the root folder).
  await expect(page.locator('.file-list .list-group')).toHaveText(['Notes', 'Ideas', 'Journal']);
  await roadmap.click();
  await expect.poll(() => editorValue(page)).toContain('# Roadmap');
  await (await headerButton(page, 'Sort')).click();
  await menuItem(page, 'Group By Folder').click();
  await expect(page.locator('.file-list .list-group')).toHaveCount(0);
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
  const groups = page.locator('.search-group');
  await input.fill('SIDEBAR');
  await expect(groups).toHaveCount(0); // runs on Enter only
  await input.press('Enter');
  await expect(groups).toHaveCount(2); // case-insensitive by default
  await expect(groups.locator('.search-line mark')).toHaveText(['sidebar', 'sidebar']);
  await expect(groups.filter({ hasText: '2026-10-16.md' }).locator('.search-file-dir')).toHaveText('Notes / Journal');
  await page.locator('.search-opt[data-opt=caseSensitive]').click(); // Match Case re-runs
  await expect(page.locator('.search-status')).toHaveText('No result found.');
  await page.locator('.search-opt[data-opt=caseSensitive]').click();
  // Whole word: "Ship" is not a word in "Shipped".
  await input.fill('Ship');
  await page.locator('.search-opt[data-opt=wholeWord]').click();
  await expect(page.locator('.search-status')).toHaveText('No result found.');
  await page.locator('.search-opt[data-opt=wholeWord]').click();
  await expect.poll(() => page.evaluate(() => window.__margin!.settings.fileSearchWholeWord)).toBe(false);
  // File-name match without content hits.
  await input.fill('reading list');
  await input.press('Enter');
  await expect(groups).toHaveCount(1);
  await expect(groups.locator('.search-file-name')).toHaveText('Reading list.md');
  // A content hit opens the file and selects the match in the editor.
  await input.fill('Shipped');
  await input.press('Enter');
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
  const ctx = async (name: string, role: 'menuitem' | 'menuitemcheckbox' = 'menuitem') => {
    await page.locator('.outline-list').click({ button: 'right', position: { x: 5, y: 2 } });
    await page.locator('.context-menu').getByRole(role, { name }).click();
  };
  await expect(items).toHaveCount(5);
  // Context menu order (flat mode).
  await page.locator('.outline-list').click({ button: 'right', position: { x: 5, y: 2 } });
  await expect(page.locator('.context-menu .context-item')).toHaveText(['Highlight Current Header', 'Filter', 'Collapsible Outline', /Flat Outline/]);
  await page.keyboard.press('Escape');
  // Filter: only matching rows, first hit marked; Escape exits.
  await ctx('Filter', 'menuitemcheckbox');
  await expect(page.locator('.outline-filter')).toBeFocused();
  await page.locator('.outline-filter').fill('中文');
  await expect(items).toHaveText(['中文排版']);
  await expect(items.locator('mark')).toHaveText('中文');
  await page.locator('.outline-filter').fill('nope');
  await expect(items).toHaveCount(0);
  await expect(page.locator('.outline-nomatch')).toHaveText('No Results');
  await page.locator('.outline-filter').press('Escape');
  await expect(page.locator('.outline-filter')).toBeHidden();
  await expect(items).toHaveCount(5);
  // Collapsible: top-level items expand; nested sections start collapsed.
  await ctx('Collapsible Outline', 'menuitemcheckbox');
  await expect(page.locator('.outline')).toHaveAttribute('data-collapsible', 'true');
  await expect(items).toHaveCount(4); // 中文排版 hidden under "Writing"
  await ctx('Collapse All');
  await expect(items).toHaveText(['Welcome to Margin']);
  await page.locator('.outline-item[aria-expanded] .outline-toggle').first().click();
  await expect(items).toHaveCount(4);
  await ctx('Expand All');
  await expect(items).toHaveCount(5);
  // Flat outline: no toggles; setting persisted.
  await ctx('Flat Outline', 'menuitemcheckbox');
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
  await page.locator('.modal-card button[data-id=move]').click(); // #131: move confirmation
  await expect(tree(page).locator(`.tree-row[data-path="${ROOT}/Journal/notes.txt"]`)).toBeVisible();
  await expect(tree(page).locator(`.tree-row[data-path="${ROOT}/notes.txt"]`)).toHaveCount(0);
  // Negative: dropping a folder into itself is refused.
  await ideas.dragTo(roadmap);
  await expect(tree(page).locator(`.tree-row[data-path="${ROOT}/Ideas"]`)).toBeVisible();
});
