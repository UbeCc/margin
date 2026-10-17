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
 * on it. The editor core is stubbed (`?stub=editor`) until #1 lands.
 */
export async function boot(page: Page): Promise<void> {
  await page.addInitScript((entries) => {
    if (!localStorage.getItem('margin.web.fs.v1')) localStorage.setItem('margin.web.fs.v1', JSON.stringify(entries));
    window.__dialogQueue = [];
    (window as unknown as { __MARGIN_DIALOG__: () => string | null }).__MARGIN_DIALOG__ = () => window.__dialogQueue!.shift() ?? null;
  }, fixtureEntries());
  await page.goto(`/?stub=editor&folder=${encodeURIComponent(ROOT)}`);
  await expect(page.locator('.app.ready')).toBeVisible();
  await expect(page.locator('.stub-editor')).toHaveValue(/# Welcome to Margin/);
}

export const editorValue = (page: Page): Promise<string> => page.locator('.stub-editor').inputValue();

/** File content on the platform's (in-memory) disk, or undefined. */
export const diskFile = (page: Page, path: string): Promise<string | undefined> =>
  page.evaluate((p) => window.__MARGIN_WEB__!.readTextFile(p).catch(() => undefined), path);

export const queueDialog = (page: Page, path: string | null): Promise<void> =>
  page.evaluate((p) => void window.__dialogQueue!.push(p), path);

export async function typeInEditor(page: Page, text: string): Promise<void> {
  const ed = page.locator('.stub-editor');
  await ed.focus();
  await page.keyboard.press(`${MOD}+End`);
  await page.keyboard.type(text);
}
