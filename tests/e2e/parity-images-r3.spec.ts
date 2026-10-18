import { expect, test, type Page } from '@playwright/test';
import { boot, caretAtText, editorValue, MOD, queueDialog } from './app-helpers';

/** Typora parity: r3 image gaps (#136 html-block re-resolve + Take Picture, #137 uploader presets). */

const PNG_1x1 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==';

type Win = Window & {
  __margin: { images: { store(i: unknown): Promise<string | null> }; updateSettings(p: object): void; editor: { setMarkdown(s: string): void } };
  __MARGIN_WEB__: Record<string, unknown> & {
    storeImage(d: string | null, r: unknown, i: unknown): Promise<string>;
    rename(a: string, b: string): Promise<void>;
    stat(p: string): Promise<unknown>;
    triggerMenu(a: string): void;
  };
  __calls?: unknown[];
};

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

test.beforeEach(async ({ page }) => {
  // Fake CDN host: fail fast (see parity-images.spec.ts).
  await page.route(/^(https?:\/\/cdn\.example\b.*)$/, (r) => r.fulfill({ status: 404, body: '' }));
  await boot(page);
  await putPng(page, '/pics/shot.png');
});

test('images.html-root-url: html-block <img> re-resolves when typora-root-url changes (#136)', async ({ page }) => {
  await putPng(page, '/Users/demo/pics/shot.png');
  await setDoc(page, '<p>html</p>\n\n<img src="pics/shot.png">\n\nqq\n');
  const img = page.locator('.mb-html-block img');
  await expect(img).toHaveCount(1);
  await expect(img).not.toHaveAttribute('src', /^data:image\/png/);

  // Toggle Use Image Root Path on: the front matter change alone must re-render
  // image-bearing html blocks (inline .md-image imgs were already patched).
  await caretAtText(page, 'qq', 1);
  await queueDialog(page, '/Users/demo');
  await menu(page, 'image:rootPath');
  await expect.poll(async () => (await img.getAttribute('src')) ?? '').toMatch(/^data:image\/png/);

  // Toggle off: back to the unresolved relative path.
  await menu(page, 'image:rootPath');
  await expect.poll(async () => (await img.getAttribute('src')) ?? '').not.toMatch(/^data:image\/png/);
});

test('images.uploader-presets: PicGo.app / uPic / Picsee in Preferences, fixed argv (#137)', async ({ page }) => {
  await page.keyboard.press(`${MOD}+Comma`);
  const prefs = page.locator('.preferences');
  await prefs.locator('.pref-tab[data-section=images]').click();
  const sel = prefs.locator('select[data-pref=uploader]');
  await expect(sel.locator('option')).toHaveText(['None', 'PicGo.app', 'uPic', 'Picsee', 'Custom Command', 'PicGo (local server)']);
  const port = prefs.locator('input[data-pref=picgoPort]');
  const cmd = prefs.locator('input[data-pref=uploadCommand]');

  await sel.selectOption('picgo-app');
  await expect(port).toBeVisible(); // shares the PicGo port
  await expect(cmd).toBeHidden();
  await sel.selectOption('upic');
  await expect(port).toBeHidden();
  await expect(cmd).toBeHidden(); // preset argv is fixed — nothing to type
  await page.evaluate(() => {
    const w = window as unknown as Win;
    w.__calls = [];
    w.__MARGIN_WEB__.uploadImages = async (paths: string[], config: unknown) => (w.__calls!.push({ paths, config }), paths.map((_, i) => `https://cdn.example/${i}.png`));
  });
  await page.keyboard.press('Escape');
  await setDoc(page, '![s](/pics/shot.png)\n');
  await menu(page, 'image:uploadAll');
  await expect.poll(() => editorValue(page)).toContain('![s](https://cdn.example/0.png)');
  expect(await page.evaluate(() => (window as unknown as Win).__calls)).toEqual([
    { paths: ['/pics/shot.png'], config: { kind: 'command', command: '/Applications/uPic.app/Contents/MacOS/uPic -o url -u', timeoutSecs: 20 } },
  ]);
});

test('images.take-picture: Format › Take Picture surfaces camera errors cleanly (#136)', async ({ page }) => {
  await setDoc(page, 'tp\n');
  await caretAtText(page, 'tp', 1);
  // automation context has no camera: the dialog must not wedge, the doc stays intact
  await menu(page, 'takePicture');
  await expect(page.locator('.toast[data-kind=error]').last()).toContainText('Camera unavailable');
  await expect.poll(() => editorValue(page)).toBe('tp\n');
  expect(await page.locator('.take-picture').count()).toBe(0);
});
