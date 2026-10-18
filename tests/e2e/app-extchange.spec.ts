import { expect, test, type Page } from '@playwright/test';
import { boot, diskFile, editorValue, MOD, ROOT, typeInEditor } from './app-helpers';

const FILE = `${ROOT}/Welcome.md`;
const extWrite = (page: Page, text: string) => page.evaluate(([p, t]) => window.__MARGIN_WEB__!.externalWrite(p, t), [FILE, text]);
const extRemove = (page: Page) => page.evaluate((p) => window.__MARGIN_WEB__!.externalRemove(p), FILE);

test.beforeEach(async ({ page }) => boot(page));

test('clean document reloads silently without a prompt', async ({ page }) => {
  await extWrite(page, '# Changed elsewhere\n\nBody.\n');
  await expect.poll(() => editorValue(page)).toBe('# Changed elsewhere\n\nBody.\n');
  await expect(page.locator('.extchange-banner')).toBeHidden();
  await expect(page.locator('.app')).not.toHaveClass(/doc-dirty/);
});

test('dirty: banner is non-blocking; Keep Mine keeps edits and the next save overwrites', async ({ page }) => {
  await typeInEditor(page, '\nmine');
  await extWrite(page, '# Disk version\n');
  const banner = page.locator('.extchange-banner');
  await expect(banner).toBeVisible();
  await expect(banner).toContainText('Welcome.md');
  // Not modal: typing still works while the banner is up.
  await page.keyboard.type('!');
  await expect.poll(() => editorValue(page)).toContain('mine!');
  await banner.locator('[data-id=keep]').click();
  await expect(banner).toBeHidden();
  await expect(page.locator('.app')).toHaveClass(/doc-dirty/);

  // Touching the same disk version again does not re-prompt.
  await extWrite(page, '# Disk version\n');
  await page.waitForTimeout(250);
  await expect(banner).toBeHidden();

  await page.keyboard.press(`${MOD}+S`);
  await expect.poll(() => diskFile(page, FILE)).toContain('mine!');
  await page.waitForTimeout(250);
  await expect(banner).toBeHidden(); // own write ignored
});

test('dirty: Load Disk replaces the buffer and Undo restores it', async ({ page }) => {
  await typeInEditor(page, '\nmine');
  await extWrite(page, '# Disk version\n');
  await page.locator('.extchange-banner [data-id=load]').click();
  await expect.poll(() => editorValue(page)).toBe('# Disk version\n');
  await expect(page.locator('.app')).not.toHaveClass(/doc-dirty/);
  await page.locator('.toast button', { hasText: 'Undo' }).click();
  await expect.poll(() => editorValue(page)).toContain('mine');
  await expect(page.locator('.app')).toHaveClass(/doc-dirty/);
});

test('Show Diff renders +/- lines and offers the same choices', async ({ page }) => {
  const before = await editorValue(page);
  await typeInEditor(page, '\nmine');
  await extWrite(page, `${before}disk only\n`);
  await page.locator('.extchange-banner [data-id=diff]').click();
  const diff = page.locator('.extdiff');
  await expect(diff).toBeVisible();
  await expect(diff.locator('.extdiff-del .extdiff-text', { hasText: 'disk only' })).toHaveCount(1);
  await expect(diff.locator('.extdiff-add .extdiff-text', { hasText: 'mine' })).toHaveCount(1);
  // Added lines are tinted differently from context in this theme.
  const bg = (sel: string) => diff.locator(sel).first().evaluate((el) => getComputedStyle(el).backgroundColor);
  expect(await bg('.extdiff-add')).not.toBe(await bg('.extdiff-del'));
  await diff.locator('[data-id=load]').click();
  await expect(diff).toBeHidden();
  await expect.poll(() => editorValue(page)).toContain('disk only');
  await expect(page.locator('.extchange-banner')).toBeHidden();
});

test('diff modal works in a dark scheme', async ({ page }) => {
  await page.evaluate(() => (document.documentElement.dataset.scheme = 'dark'));
  await typeInEditor(page, '\nmine');
  await extWrite(page, '# Disk\n');
  await page.locator('.extchange-banner [data-id=diff]').click();
  const add = page.locator('.extdiff-add').first();
  await expect(add).toBeVisible();
  const [bg, fg] = await add.evaluate((el) => [getComputedStyle(el).backgroundColor, getComputedStyle(el).color]);
  expect(bg).not.toBe(fg);
  await page.keyboard.press('Escape');
  await expect(page.locator('.extdiff')).toBeHidden();
  await expect(page.locator('.extchange-banner')).toBeVisible(); // still undecided
});

test('deleted on disk: warns, hides the prompt, keeps the buffer dirty', async ({ page }) => {
  await typeInEditor(page, '\nmine');
  await extWrite(page, '# Disk\n');
  await expect(page.locator('.extchange-banner')).toBeVisible();
  await extRemove(page);
  await expect(page.locator('.toast', { hasText: 'deleted' })).toBeVisible();
  await expect(page.locator('.extchange-banner')).toBeHidden();
  await expect(page.locator('.app')).toHaveClass(/doc-dirty/);
  await expect.poll(() => editorValue(page)).toContain('mine');
});
