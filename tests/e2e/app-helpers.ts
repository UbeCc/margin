import { expect, type Page } from '@playwright/test';
import type { WebPlatform } from '../../src/platform/web';
import { fixtureEntries, ROOT } from './app-fixture';

export { ROOT } from './app-fixture';
export const MOD = 'ControlOrMeta';

declare global {
  interface Window {
    __MARGIN_WEB__?: WebPlatform;
    __dialogQueue?: (string | null)[];
  }
}

/**
 * Seed the fixture folder into the real in-browser platform (first load only, so
 * reloads keep persisted state), route file dialogs to a queue, and boot the app
 * on it with the real editor core (`.md-editor`, EditorHandle on `window.__margin.editor`).
 */
export async function boot(page: Page, query = ''): Promise<void> {
  await page.addInitScript((entries) => {
    if (!localStorage.getItem('margin.web.fs.v1')) localStorage.setItem('margin.web.fs.v1', JSON.stringify(entries));
    window.__dialogQueue = [];
    (window as unknown as { __MARGIN_DIALOG__: () => string | null }).__MARGIN_DIALOG__ = () => window.__dialogQueue!.shift() ?? null;
  }, fixtureEntries());
  await page.goto(`/?folder=${encodeURIComponent(ROOT)}${query}`);
  await expect(page.locator('.app.ready')).toBeVisible();
  await expect(page.locator('.md-editor')).toBeVisible();
  await expect.poll(() => editorValue(page)).toContain('# Welcome to Margin');
}

/** Markdown of the current document, from the real EditorHandle. */
export const editorValue = (page: Page): Promise<string> => page.evaluate(() => window.__margin!.editor.getMarkdown());

/** Put the caret at markdown offset `index` of the block whose text starts with `prefix`. */
export async function caretAtText(page: Page, text: string, offset = 0): Promise<void> {
  await page.evaluate(
    ({ text, offset }) => {
      const root = document.querySelector('.md-editor') as HTMLElement;
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      for (let n = walker.nextNode(); n; n = walker.nextNode()) {
        const i = n.textContent!.indexOf(text);
        if (i < 0) continue;
        root.focus();
        const r = document.createRange();
        r.setStart(n, i + offset);
        r.collapse(true);
        const sel = getSelection()!;
        sel.removeAllRanges();
        sel.addRange(r);
        document.dispatchEvent(new Event('selectionchange'));
        return;
      }
      throw new Error(`text not found: ${text}`);
    },
    { text, offset },
  );
}

/** File content on the platform's (in-memory) disk, or undefined. */
export const diskFile = (page: Page, path: string): Promise<string | undefined> =>
  page.evaluate((p) => window.__MARGIN_WEB__!.readTextFile(p).catch(() => undefined), path);

export const queueDialog = (page: Page, path: string | null): Promise<void> =>
  page.evaluate((p) => void window.__dialogQueue!.push(p), path);

export async function typeInEditor(page: Page, text: string): Promise<void> {
  await page.locator('.md-editor').click();
  await page.keyboard.press(`${MOD}+End`);
  await page.keyboard.type(text);
}
