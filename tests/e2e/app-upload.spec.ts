import { expect, test } from '@playwright/test';
import { boot, editorValue, MOD, ROOT } from './app-helpers';

declare global {
  interface Window {
    __uploads?: { paths: string[]; config: unknown }[];
  }
}

/** #80: Preferences › Images uploader + "Upload Image" on a rendered image (desktop upload mocked). */
/** Put a real 1×1 PNG at `path` in the in-memory disk so the image loads (Typora gates Upload Image on a loaded image, #97). */
async function seedPng(page: import('@playwright/test').Page, path: string): Promise<void> {
  await page.evaluate((p) => {
    const web = window.__MARGIN_WEB__ as unknown as { putFile(path: string, content: string, binary: boolean): unknown };
    web.putFile(p, 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PzWvWQAAAABJRU5ErkJggg==', true);
  }, path);
}

test('upload image from the context menu replaces its src with the URL', async ({ page }) => {
  await boot(page);
  // The web build has no uploader; emulate the desktop capability on the live platform.
  await page.evaluate(() => {
    window.__uploads = [];
    (window.__MARGIN_WEB__ as unknown as { uploadImages: unknown }).uploadImages = async (paths: string[], config: unknown) => {
      window.__uploads!.push({ paths, config });
      return paths.map((_, i) => `https://cdn.example/${i}.png`);
    };
  });
  await seedPng(page, `${ROOT}/assets/shot 1.png`);
  await page.evaluate(() => window.__margin!.editor.setMarkdown('# Pics\n\n![shot](assets/shot%201.png)\n'));

  await page.keyboard.press(`${MOD}+Comma`);
  const prefs = page.locator('.preferences');
  await prefs.locator('.pref-tab[data-section=images]').click();
  await prefs.locator('select[data-pref=uploader]').selectOption('command');
  await prefs.locator('input[data-pref=uploadCommand]').fill("'/opt/up loader' -u");
  await prefs.locator('input[data-pref=uploadCommand]').blur();
  await page.keyboard.press('Escape');
  await expect(prefs).toHaveCount(0);

  await page.locator('.md-editor img.md-img').first().click({ button: 'right' });
  await page.locator('.context-item', { hasText: 'Upload Image' }).click();
  await expect.poll(() => editorValue(page)).toBe('# Pics\n\n![shot](https://cdn.example/0.png)\n');
  const calls = await page.evaluate(() => window.__uploads);
  expect(calls).toEqual([{ paths: [`${ROOT}/assets/shot 1.png`], config: { kind: 'command', command: "'/opt/up loader' -u", timeoutSecs: 30 } }]);
  await expect.poll(() => page.evaluate(() => localStorage.getItem('margin.web.settings.v1') ?? '')).toContain('"uploader":"command"');
});

test('upload failure keeps the local image and shows an error', async ({ page }) => {
  await boot(page);
  await page.evaluate(() => {
    (window.__MARGIN_WEB__ as unknown as { uploadImages: unknown }).uploadImages = async () => {
      throw new Error('uploader timed out after 30s and was stopped');
    };
  });
  await seedPng(page, `${ROOT}/a.png`);
  await page.evaluate(() => window.__margin!.editor.setMarkdown('![a](a.png)\n'));
  await page.keyboard.press(`${MOD}+Comma`);
  const prefs = page.locator('.preferences');
  await prefs.locator('.pref-tab[data-section=images]').click();
  await prefs.locator('select[data-pref=uploader]').selectOption('picgo');
  await page.keyboard.press('Escape');

  await page.locator('.md-editor img.md-img').first().click({ button: 'right' });
  await page.locator('.context-item', { hasText: 'Upload Image' }).click();
  await expect(page.locator('.toast[data-kind=error]')).toContainText('timed out');
  expect(await editorValue(page)).toBe('![a](a.png)\n');
});
