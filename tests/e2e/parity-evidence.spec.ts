/**
 * Parity verifiers for owned surfaces that had no named passing test (r6 evidence pass).
 * One test per surface; titles carry the surface id for the parity ledger binding.
 * Native menus deliver these as `App.run(menuAction)`; native-only parts are covered by
 * src-tauri/tests/menu_main.rs.
 */
import { expect, test, type Page } from '@playwright/test';
import { basename } from 'node:path';
import { boot, queueDialog, ROOT, typeInEditor } from './app-helpers';

test.beforeEach(async ({ page }) => boot(page));

const run = (page: Page, id: string) => page.evaluate((a) => window.__margin!.run(a as never), id);
const web = <T>(page: Page, key: string) => page.evaluate((k) => (window.__MARGIN_WEB__ as unknown as Record<string, unknown>)[k], key) as Promise<T>;
const openDoc = (page: Page, path: string, md: string) =>
  page.evaluate(
    async ({ path, md }) => {
      await window.__MARGIN_WEB__!.writeTextFile(path, md);
      await window.__margin!.doc.open(path);
    },
    { path, md },
  );
const dataTheme = (page: Page) => page.evaluate(() => document.documentElement.dataset.theme);
const dialogButtons = (page: Page) => page.locator('.dialog-card .dialog-buttons button');

test('menu.file.print: File › Print — prints; a dark theme asks Cancel / Print with default theme / Export to PDF', async ({ page }) => {
  // Light theme: straight to the system print dialog.
  expect(await run(page, 'print')).toBe(true);
  expect(await web<number>(page, 'printed')).toBe(1);
  await expect(page.locator('#margin-print-page')).toBeAttached(); // @page CSS from the PDF page setup

  // Dark theme (export-print §4.2): Typora's three-button alert first.
  await run(page, 'theme:night');
  await expect.poll(() => dataTheme(page)).toBe('night');
  let done = run(page, 'print');
  await expect(page.locator('.dialog-card .dialog-message')).toContainText('dark theme is not yet supported for printing');
  await expect(dialogButtons(page)).toHaveText(['Cancel', 'Print with default theme', 'Export to PDF']);
  await dialogButtons(page).nth(0).click();
  expect(await done).toBe(false);
  expect(await web<number>(page, 'printed')).toBe(1);

  done = run(page, 'print');
  await dialogButtons(page).nth(1).click();
  expect(await done).toBe(true);
  expect(await web<number>(page, 'printed')).toBe(2);
  expect(await dataTheme(page)).toBe('night'); // restored after printing with the default theme

  await openDoc(page, `${ROOT}/Printed.md`, '# Printed\n');
  await queueDialog(page, `${ROOT}/Printed.pdf`);
  done = run(page, 'print');
  await dialogButtons(page).nth(2).click();
  expect(await done).toBe(true);
  await expect.poll(() => page.evaluate(() => window.__MARGIN_WEB__!.exports.at(-1)?.path)).toBe(`${ROOT}/Printed.pdf`);
  expect(await web<number>(page, 'printed')).toBe(2);
});

test('menu.view.zoom: View › Actual Size / Zoom In / Zoom Out', async ({ page }) => {
  const zoom = () => page.evaluate(() => [window.__margin!.settings.zoom, document.documentElement.style.getPropertyValue('zoom')]);
  expect(await zoom()).toEqual([1, '']);
  await run(page, 'zoomIn');
  expect(await zoom()).toEqual([1.1, '1.1']);
  await expect(page.locator('.toast').last()).toContainText('Zoom 110%');
  await run(page, 'zoomOut');
  await run(page, 'zoomOut');
  expect(await zoom()).toEqual([0.9, '0.9']);
  for (let i = 0; i < 10; i++) await run(page, 'zoomOut');
  expect((await zoom())[0]).toBe(0.5); // clamped at the smallest step
  await run(page, 'zoomReset');
  expect(await zoom()).toEqual([1, '']);
});

test('menu.themes.folder: Themes › Open Theme Folder reveals the user themes folder', async ({ page }) => {
  expect(await run(page, 'openThemesFolder')).toBe(true);
  const revealed = await web<string[]>(page, 'revealed');
  const dir = await page.evaluate(() => window.__MARGIN_WEB__!.themesDir());
  expect(revealed.at(-1)).toBe(dir);
  expect((await page.evaluate((d) => window.__MARGIN_WEB__!.stat(d), dir))?.isDir).toBe(true);
});

test('export.pdf: Export › PDF writes the rendered document to the chosen path', async ({ page }) => {
  await openDoc(page, `${ROOT}/Paper.md`, '# Paper\n\nSome **bold** text and $x$.\n');
  await queueDialog(page, `${ROOT}/Paper.pdf`);
  expect(await run(page, 'exportPdf')).toBe(true);
  await expect(page.locator('.toast').last()).toContainText('Exported Paper.pdf');
  const e = await page.evaluate(() => {
    const x = window.__MARGIN_WEB__!.exports.at(-1)!;
    return { kind: x.kind, path: x.path, html: x.html };
  });
  expect(e.kind).toBe('pdf');
  expect(e.path).toBe(`${ROOT}/Paper.pdf`);
  expect(e.html).toContain('<strong>bold</strong>');
  expect(e.html).toMatch(/<h1[^>]*>Paper<\/h1>/);
  expect(e.html).toMatch(/<style[\s\S]*<\/style>/); // theme CSS inlined
  // Cancelled save dialog: nothing exported.
  const n = await page.evaluate(() => window.__MARGIN_WEB__!.exports.length);
  await queueDialog(page, null);
  await run(page, 'exportPdf');
  expect(await page.evaluate(() => window.__MARGIN_WEB__!.exports.length)).toBe(n);
});

test('beh.files.title-dirty: Window title shows document name and edited state', async ({ page }) => {
  const path = `${ROOT}/Titled.md`;
  await openDoc(page, path, '# Titled\n');
  const state = () => page.evaluate(() => [document.title, (window.__MARGIN_WEB__ as unknown as { edited: boolean }).edited] as const);
  await expect.poll(state).toEqual([`Titled.md — ${basename(ROOT)}`, false]);
  await typeInEditor(page, ' more');
  await expect.poll(state).toEqual([`• Titled.md — ${basename(ROOT)}`, true]);
  await run(page, 'save');
  await expect.poll(state).toEqual([`Titled.md — ${basename(ROOT)}`, false]);
});
