import { expect, test, type Page } from '@playwright/test';
import { boot, editorValue } from './app-helpers';

/** Typora parity: TextBundle documents (#157, images §3.1/§3.2, fe-sidebar §1/§5/§11). */

const PNG_1x1 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==';

type Win = Window & {
  __margin: { images: { store(i: unknown): Promise<string | null> }; editor: { setMarkdown(s: string): void }; docs: { openPath(p: string, m: string): Promise<boolean> } };
  __MARGIN_WEB__: Record<string, unknown> & {
    writeTextFile(p: string, t: string): Promise<void>;
    stat(p: string): Promise<{ isDir: boolean } | null>;
    quickOpen(root: string, q: string): Promise<string[]>;
    openFiles(paths: string[]): void;
    triggerMenu(a: string): void;
  };
};

const stat = (page: Page, p: string) => page.evaluate((x) => (window as unknown as Win).__MARGIN_WEB__.stat(x), p);
const quickOpen = (page: Page, root: string, q: string) => page.evaluate(
  (a) => (window as unknown as Win).__MARGIN_WEB__.quickOpen(a.root, a.q),
  { root, q },
);
const menu = (page: Page, a: string) => page.evaluate((x) => (window as unknown as Win).__MARGIN_WEB__.triggerMenu(x), a);
const row = (page: Page, p: string) => page.locator(`.tree-row[data-path="${p}"]`);

async function makeBundle(page: Page, path: string, md: string): Promise<void> {
  await page.evaluate(({ path, md }) => (window as unknown as Win).__MARGIN_WEB__.writeTextFile(path, md), { path, md });
}

test.beforeEach(async ({ page }) => {
  await boot(page);
});

test('images.textbundle: TextBundle opens as one document, images go to <bundle>/assets, rename guard', async ({ page }) => {
  const bundle = '/Margin/Notes/journal.textbundle';
  await makeBundle(page, bundle, '# Demo\n');

  // Sidebar: the bundle folder shows as a single file row (fe-sidebar §1)…
  await page.evaluate(() => (window as unknown as Win).__MARGIN_WEB__.openFiles(['/Margin/Notes']));
  const r = row(page, bundle);
  await expect(r).toHaveCount(1);
  await expect(r).toHaveAttribute('data-kind', 'file');
  await expect(page.locator('.tree-row[data-path="' + bundle + '/text.md"]')).toHaveCount(0);

  // …and opens as a document (fe-sidebar §11).
  await r.click();
  await expect.poll(() => editorValue(page)).toBe('# Demo\n');

  // Inserted images land in <bundle>/assets even with YAML/global rules set elsewhere (§3.1).
  await page.evaluate(() => (window as unknown as Win).__margin.editor.setMarkdown('---\ntypora-copy-images-to: ./pics\n---\n\n# Demo\n'));
  const bytes = Uint8Array.from(atob(PNG_1x1), (c) => c.charCodeAt(0));
  const snippet = await page.evaluate(async (b) => (window as unknown as Win).__margin.images.store({ bytes: new Uint8Array(b), mime: 'image/png' }), [...bytes]);
  expect(snippet).toMatch(/^!\[\]\(assets\/image-\d+\.png\)$/);
  const stored = `/Margin/Notes/journal.textbundle/${snippet!.match(/\((.*)\)/)![1]}`;
  expect(await stat(page, stored)).toMatchObject({ isDir: false });
  expect(await stat(page, '/Margin/Notes/pics')).toBeNull();

  // Saving writes the content file (text.md, images §3.4), keeping info.json and assets/ intact.
  await page.evaluate(() => (window as unknown as Win).__margin.editor.setMarkdown('# Demo\n\nedited\n'));
  await menu(page, 'save');
  await expect(page.locator('.toast').last()).toContainText('Saved');
  await expect.poll(() => editorValue(page)).toBe('# Demo\n\nedited\n');
  const disk = page.evaluate(
    (p) => (window as unknown as Win & { __MARGIN_WEB__: { readTextFile(p: string): Promise<string> } }).__MARGIN_WEB__.readTextFile(p),
    `${bundle}/text.md`,
  );
  await expect.poll(() => disk).toBe('# Demo\n\nedited\n');

  // Quick Open lists the bundle as one file, never its children (editor-core §9/§10).
  const qo = await quickOpen(page, '/Margin', 'journal');
  expect(qo).toContain(bundle);
  expect(qo.every((p) => !p.includes('text.md') && !p.includes('info.json'))).toBe(true);

  // Markdown ↔ TextBundle renames are refused with Typora's wording (fe-sidebar §5)…
  await row(page, bundle).click({ button: 'right' });
  await page.locator('.context-menu .context-item', { hasText: 'Rename…' }).click();
  const input = page.locator('.dialog .text-input');
  await input.fill('journal.md');
  await page.keyboard.press('Enter');
  await expect(page.locator('.toast').last()).toContainText(
    'Cannot rename from TextBundle file to Markdown file, please use "File" → "Move To…" from menubar instead.',
  );
  await expect(row(page, bundle)).toHaveCount(1); // bundle intact

  // …and the reverse direction too.
  const md = '/Margin/Notes/plain.md';
  await makeBundle(page, md, '# plain\n');
  await row(page, md).click({ button: 'right' });
  await page.locator('.context-menu .context-item', { hasText: 'Rename…' }).click();
  await input.fill('plain.textbundle');
  await page.keyboard.press('Enter');
  await expect(page.locator('.toast').last()).toContainText(
    'Cannot rename from Markdown file to TextBundle file, please use "File" → "Move To…" from menubar instead.',
  );
  await expect(row(page, md)).toHaveCount(1);
});
