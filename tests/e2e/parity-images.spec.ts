import { expect, test, type Page } from '@playwright/test';
import { boot, caretAtText, editorValue, MOD, queueDialog, ROOT } from './app-helpers';

/** Typora parity: image pipeline (#99 / #92). One test per ledger surface. */

const PNG_1x1 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==';

type Win = Window & {
  __margin: { images: { store(i: unknown): Promise<string | null> }; updateSettings(p: object): void; editor: { setMarkdown(s: string): void } };
  __MARGIN_WEB__: Record<string, unknown> & {
    storeImage(d: string | null, r: unknown, i: unknown): Promise<string>;
    rename(a: string, b: string): Promise<void>;
    stat(p: string): Promise<unknown>;
    triggerMenu(a: string): void;
    revealed: string[];
    imageScales: Map<string, number>;
  };
  __calls?: unknown[];
};

/** Write a real 1×1 PNG at `path` in the in-browser filesystem. */
async function putPng(page: Page, path: string): Promise<void> {
  await page.evaluate(
    async ({ path, b64 }) => {
      const w = window as unknown as Win;
      const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
      const dir = path.slice(0, path.lastIndexOf('/'));
      const made = await w.__MARGIN_WEB__.storeImage(null, { kind: 'absolute', dir }, { bytes, mime: 'image/png' });
      await w.__MARGIN_WEB__.rename(decodeURI(made), path);
    },
    { path, b64: PNG_1x1 },
  );
}

const setDoc = (page: Page, md: string) => page.evaluate((m) => (window as unknown as Win).__margin.editor.setMarkdown(m), md);
const menu = (page: Page, a: string) => page.evaluate((x) => (window as unknown as Win).__MARGIN_WEB__.triggerMenu(x), a);
const settings = (page: Page, p: object) => page.evaluate((x) => (window as unknown as Win).__margin.updateSettings(x), p);
const exists = (page: Page, p: string) => page.evaluate(async (x) => !!(await (window as unknown as Win).__MARGIN_WEB__.stat(x)), p);
/**
 * Right-click the i-th rendered image. Guards first (#152): a sub-2px hit box
 * passes Playwright's visibility check, but Linux WebKit snaps it to a zero-width
 * hit area — the click then retries on "<div class=\"md-content\"> intercepts
 * pointer events" until the whole 30s test budget is gone. Fail fast instead,
 * and bound the click so any future interception surfaces quickly.
 */
const rightClickImage = async (page: Page, i = 0): Promise<void> => {
  const img = page.locator('.md-editor .md-image img.md-img, .md-editor .mb-html-block img').nth(i);
  await expect(img).toBeVisible();
  const box = await img.boundingBox();
  expect(box && Math.min(box.width, box.height), 'image hit box too small to right-click (#152)').toBeGreaterThanOrEqual(2);
  await img.click({ button: 'right', timeout: 10_000 });
};
const ctxItem = (page: Page, label: string | RegExp) => page.locator('.context-item', { hasText: label });

test.beforeEach(async ({ page }) => {
  // Fake hosts: fail fast so webkit/chromium don't sit on pending requests through a
  // live proxy (breaks click actionability); never touch the localhost dev server.
  await page.route(/^(https?:\/\/(x\.example|cdn\.example|example\.com)\b.*)$/, (r) => r.fulfill({ status: 404, body: '' }));
  await boot(page);
  await putPng(page, '/pics/shot.png');
});

test('menu.format.image: Format › Image › Insert Image / Insert Local Images…', async ({ page }) => {
  await setDoc(page, '# Pics\n\nend\n');
  await caretAtText(page, 'end', 3);
  await queueDialog(page, '/pics/shot.png');
  await menu(page, 'image:insertLocal');
  // default rule ./assets: copied next to the document, alt = file name
  await expect.poll(() => editorValue(page)).toBe('# Pics\n\nend![shot](assets/shot.png)\n');
  expect(await exists(page, `${ROOT}/assets/shot.png`)).toBe(true);
  expect(await exists(page, '/pics/shot.png')).toBe(true);
  await caretAtText(page, 'end', 0);
  await menu(page, 'image:insert');
  await expect.poll(() => editorValue(page)).toContain('![]()end');
  // cancelled dialog inserts nothing
  await menu(page, 'image:insertLocal');
  await expect.poll(() => editorValue(page)).toBe('# Pics\n\n![]()end![shot](assets/shot.png)\n');
});

test('images.rules-scope: Image rule options: apply to local/online images, relative path, ./ prefix, escape URL, YAML override', async ({ page }) => {
  await setDoc(page, '---\ntypora-copy-images-to: ./img-${filename}\n---\n\nx\n');
  await caretAtText(page, 'x', 1);
  await queueDialog(page, '/pics/shot.png');
  await menu(page, 'image:insertLocal');
  await expect.poll(() => editorValue(page)).toContain('x![shot](img-Welcome/shot.png)');
  expect(await exists(page, `${ROOT}/img-Welcome/shot.png`)).toBe(true);

  // Preferences toggles: ./ prefix on; then "apply to local images" off → referenced in place.
  await page.keyboard.press(`${MOD}+Comma`);
  const prefs = page.locator('.preferences');
  await prefs.locator('.pref-tab[data-section=images]').click();
  await expect(prefs.locator('input[name=imageInsertAction][value=assets]')).toBeChecked();
  await prefs.locator('input[data-pref=imageDotPrefix]').check();
  await page.keyboard.press('Escape');
  await setDoc(page, 'y\n');
  await caretAtText(page, 'y', 1);
  await queueDialog(page, '/pics/shot.png');
  await menu(page, 'image:insertLocal');
  await expect.poll(() => editorValue(page)).toBe('y![shot](./assets/shot.png)\n');

  await settings(page, { imageApplyLocal: false });
  await setDoc(page, 'z\n');
  await caretAtText(page, 'z', 1);
  await queueDialog(page, '/pics/shot.png');
  await menu(page, 'image:insertLocal');
  await expect.poll(() => editorValue(page)).toBe('z![shot](../../../pics/shot.png)\n');
});

test('images.root-path: Image root path (typora-root-url)', async ({ page }) => {
  await setDoc(page, '# R\n\nqqq\n');
  await queueDialog(page, '/Users/demo');
  await menu(page, 'image:rootPath');
  await expect.poll(() => editorValue(page)).toBe('---\ntypora-root-url: ..\n---\n\n# R\n\nqqq\n');
  await caretAtText(page, 'qqq', 3);
  await queueDialog(page, '/pics/shot.png');
  await menu(page, 'image:insertLocal');
  // root-url mode writes site-root paths, and they render from the root
  await expect.poll(() => editorValue(page)).toContain('qqq![shot](/Notes/assets/shot.png)');
  await expect(page.locator('.md-editor img.md-img').first()).toHaveAttribute('src', /^data:image\/png/);
  // toggling again removes the key (Typora's checkmark item)
  await menu(page, 'image:rootPath');
  await expect.poll(() => editorValue(page)).not.toContain('typora-root-url');
});

test('images.remote-download: Download remote images into the target folder', async ({ page }) => {
  await page.evaluate(() => {
    const w = window as unknown as Win;
    const real = w.__MARGIN_WEB__.storeImage.bind(w.__MARGIN_WEB__);
    w.__calls = [];
    w.__MARGIN_WEB__.storeImage = async (d, r, i) => (w.__calls!.push({ r, i }), real(d, r, i));
  });
  const store = (src: string) => page.evaluate((s) => (window as unknown as Win).__margin.images.store({ path: s }), src);
  // "Apply above rules to online images" is off by default: the URL is referenced as is
  expect(await store('https://example.com/a.png')).toBe('![](https://example.com/a.png)');
  expect(await page.evaluate(() => (window as unknown as Win).__calls!.length)).toBe(0);
  await settings(page, { imageApplyOnline: true });
  await store('https://example.com/b.png');
  expect(await page.evaluate(() => (window as unknown as Win).__calls)).toEqual([{ r: { kind: 'relative', dir: './assets' }, i: { path: 'https://example.com/b.png' } }]);
});

test('images.copy-move-all: Image Tools: Copy / Move All Images to… (and per-image copy/move/rename)', async ({ page }) => {
  await putPng(page, `${ROOT}/assets/a.png`);
  await setDoc(page, '![a](assets/a.png)\n\n![s](/pics/shot.png) and ![a2](assets/a.png)\n\n![w](https://x.example/w.png)\n');
  await queueDialog(page, `${ROOT}/out`);
  await menu(page, 'image:copyAll');
  await expect.poll(() => editorValue(page)).toBe('![a](out/a.png)\n\n![s](out/shot.png) and ![a2](out/a.png)\n\n![w](https://x.example/w.png)\n');
  await expect(page.locator('.toast').last()).toContainText(`Images copied to ${ROOT}/out.`);
  expect(await exists(page, `${ROOT}/assets/a.png`)).toBe(true);

  await queueDialog(page, `${ROOT}/moved`);
  await menu(page, 'image:moveAll');
  await expect.poll(() => editorValue(page)).toContain('![a](moved/a.png)');
  expect(await exists(page, `${ROOT}/out/a.png`)).toBe(false);
  expect(await exists(page, `${ROOT}/moved/shot.png`)).toBe(true);

  // per image: Copy Image to… from the context menu; a clash with other bytes → stem-<7 digits>
  await putPng(page, `${ROOT}/other/a.png`);
  await page.evaluate(async () => {
    const w = window as unknown as Win & { __MARGIN_WEB__: { writeTextFile(p: string, c: string): Promise<void> } };
    await w.__MARGIN_WEB__.writeTextFile('/Users/demo/Notes/dest/a.png', 'different bytes');
  });
  await rightClickImage(page, 0);
  await queueDialog(page, `${ROOT}/dest`);
  await ctxItem(page, 'Copy Image to…').click();
  await expect.poll(() => editorValue(page)).toMatch(/^!\[a\]\(dest\/a-\d{7}\.png\)/);

  // nothing local → message
  await setDoc(page, '![w](https://x.example/w.png)\n');
  await menu(page, 'image:copyAll');
  await expect(page.locator('.toast').last()).toContainText('No local images found.');
});

test('images.delete: Image context: Delete Image / Delete Image File (undoable)', async ({ page }) => {
  await setDoc(page, 'a ![s](https://x.example/s.png) b\n');
  await rightClickImage(page);
  // remote image: reference-only "Delete Image" (no file on disk)
  await ctxItem(page, /^Delete Image$/).click();
  await expect.poll(() => editorValue(page)).toBe('a  b\n');
  await page.locator('.md-editor').click();
  await page.keyboard.press(`${MOD}+z`);
  await expect.poll(() => editorValue(page)).toBe('a ![s](https://x.example/s.png) b\n');

  // A 24×24 PNG: a 1×1 image at a fractional inline offset rounds to a 0-width
  // hit box on Linux WebKit and cannot be clicked (app renders natural size).
  await page.evaluate(
    (b64) => {
      const w = window as unknown as Win;
      const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
      void w.__MARGIN_WEB__.storeImage(null, { kind: 'absolute', dir: '/pics' }, { bytes, mime: 'image/png' }).then(async (made) => {
        await w.__MARGIN_WEB__.rename(decodeURI(made), '/pics/del.png');
      });
    },
    'iVBORw0KGgoAAAANSUhEUgAAABgAAAAYCAIAAABvFaqvAAAAH0lEQVR4nGOYcOADVRDDqEGjBo0aNGrQqEGjBg28QQDyphBMTK0GVQAAAABJRU5ErkJggg==',
  );
  await setDoc(page, 'a ![s](/pics/del.png) b\n');

  await rightClickImage(page);
  await ctxItem(page, 'Delete Image File').click();
  const dlg = page.locator('.dialog');
  await expect(dlg).toContainText('Are you sure you want to delete del.png?');
  await dlg.locator('button[data-id=cancel]').click();
  expect(await exists(page, '/pics/del.png')).toBe(true);
  await rightClickImage(page);
  await ctxItem(page, 'Delete Image File').click();
  await page.locator('.dialog button[data-id=ok]').click();
  await expect.poll(() => editorValue(page)).toBe('a  b\n');
  expect(await exists(page, '/pics/del.png')).toBe(false);
});

test('images.reveal-open: Image context: Open Image Location… / Open in Browser… / Copy Image Content', async ({ page }) => {
  await page.evaluate(() => {
    const w = window as unknown as Win;
    w.__calls = [];
    w.__MARGIN_WEB__.openExternal = async (u: string) => void w.__calls!.push(u);
  });
  await setDoc(page, '![s](/pics/shot.png)\n\n![w](https://x.example/w.png)\n');
  await rightClickImage(page, 0);
  // §1.2 order: reveal / copy-move / upload | zoom, syntax, delete | system items | Save Image As…
  const labels = page.locator('.context-menu:not(.context-submenu) > .context-item .context-label');
  await expect(labels).toHaveText([
    'Open Image Location…', 'Copy to /Users/demo/Notes/assets', 'Copy Image to…',
    'Move to /Users/demo/Notes/assets', 'Rename or Move Image to…', 'Upload Image',
    'Zoom Image', 'Switch Image Syntax', 'Delete Image File',
    'Cut', 'Copy', 'Copy Image Content', 'Paste', 'Copy / Paste As…', 'Save Image As…',
  ]);
  await expect(page.locator('.context-sep', { hasText: '' })).not.toHaveCount(0); // separators preserved
  await expect(ctxItem(page, 'Open Image in Browser')).toHaveCount(0);
  await ctxItem(page, /^Open Image Location…$/).click();
  expect(await page.evaluate(() => (window as unknown as Win).__MARGIN_WEB__.revealed)).toEqual(['/pics/shot.png']);
  await rightClickImage(page, 1);
  await expect(ctxItem(page, 'Open Image Location…')).toHaveCount(0);
  await ctxItem(page, /^Open Image in Browser…$/).click();
  expect(await page.evaluate(() => (window as unknown as Win).__calls)).toEqual(['https://x.example/w.png']);
});

test('images.zoom: Image zoom (direct entry + presets) and switch Markdown/HTML image syntax', async ({ page }) => {
  await setDoc(page, '![s](/pics/shot.png)\n');
  await rightClickImage(page);
  // no zoom set: only the submenu (25 33 50 67 | 100 150 200), nothing checked
  await page.locator('.context-item[data-key=zoomImg]').hover();
  await expect(page.locator('.context-submenu .context-label')).toHaveText(['25%', '33%', '50%', '67%', '100%', '150%', '200%']);
  await page.getByRole('menuitemcheckbox', { name: '50%', exact: true }).click();
  await expect.poll(() => editorValue(page)).toBe('<img src="/pics/shot.png" alt="s" style="zoom:50%;" />\n');
  // zoomed: the direct "Zoom Image to N%" entry appears and the preset is checked
  await rightClickImage(page);
  await expect(ctxItem(page, 'Zoom Image to 50%')).toBeVisible();
  await page.locator('.context-item[data-key=zoomImg]').hover();
  await expect(page.locator('.context-submenu .context-item[aria-checked=true] .context-label')).toHaveText(['50%']);
  await page.locator('.context-item[data-key=imgSyntax]').hover();
  await expect(page.locator('.context-submenu .context-item[aria-checked=true] .context-label')).toHaveText(['HTML Style']);
  await page.locator(".context-item[data-key='imgSyntax:md']").click();
  await expect.poll(() => editorValue(page)).toBe('![s](/pics/shot.png)\n');
  await rightClickImage(page);
  await page.locator('.context-item[data-key=imgSyntax]').hover();
  await page.locator(".context-item[data-key='imgSyntax:html']").click();
  await expect.poll(() => editorValue(page)).toBe('<img src="/pics/shot.png" alt="s" />\n');
});

test('images.upload: Image upload: custom command (argv) / PicGo; upload one / all local images; test uploader', async ({ page }) => {
  await page.evaluate(() => {
    const w = window as unknown as Win;
    w.__calls = [];
    w.__MARGIN_WEB__.uploadImages = async (paths: string[]) => (w.__calls!.push(paths), paths.map((_, i) => `https://cdn.example/${i}.png`));
    w.__MARGIN_WEB__.testUploader = async () => ({ ok: true, command: "'/opt/up' -u /tmp/margin-test-1.png /tmp/margin-test-2.png", stdout: 'ok\n', stderr: '', urls: ['https://cdn.example/1.png', 'https://cdn.example/2.png'], message: 'Successfully get uploaded image url.' });
  });
  await page.keyboard.press(`${MOD}+Comma`);
  const prefs = page.locator('.preferences');
  await prefs.locator('.pref-tab[data-section=images]').click();
  await prefs.locator('select[data-pref=uploader]').selectOption('command');
  await prefs.locator('input[data-pref=uploadCommand]').fill("'/opt/up' -u");
  await prefs.locator('input[data-pref=uploadCommand]').blur();
  await prefs.locator('button[data-pref=testUploader]').click();
  await expect(prefs.locator('[data-pref=uploadReport]')).toContainText('Validation Succeed');
  await expect(prefs.locator('[data-pref=uploadReport]')).toContainText('Testing image uploading using command:');
  // When Insert… → Upload image
  await prefs.locator('input[name=imageInsertAction][value=upload]').check();
  await page.keyboard.press('Escape');

  await setDoc(page, 'u\n');
  await caretAtText(page, 'u', 1);
  await queueDialog(page, '/pics/shot.png');
  await menu(page, 'image:insertLocal');
  await expect.poll(() => editorValue(page)).toBe('u![shot](https://cdn.example/0.png)\n');
  expect(await page.evaluate(() => (window as unknown as Win).__calls)).toEqual([['/pics/shot.png']]);

  // failure keeps the local image
  await page.evaluate(() => {
    (window as unknown as Win).__MARGIN_WEB__.uploadImages = async () => {
      throw new Error('Command timeout');
    };
  });
  await setDoc(page, 'v\n');
  await caretAtText(page, 'v', 1);
  await queueDialog(page, '/pics/shot.png');
  await menu(page, 'image:insertLocal');
  await expect.poll(() => editorValue(page)).toBe('v![shot](../../../pics/shot.png)\n');
  await expect(page.locator('.toast[data-kind=error]').last()).toContainText('Failed to upload image. Error Message: Command timeout');
});

test('images.reload: Image Tools: Reload All Images', async ({ page }) => {
  await setDoc(page, '![w](https://x.example/w.png)\n');
  await menu(page, 'image:reloadAll');
  await expect(page.locator('.md-editor img.md-img').first()).toHaveAttribute('src', /margin-reload=\d+/);
});
