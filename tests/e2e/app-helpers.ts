import { expect, type Page } from '@playwright/test';

export const ROOT = '/Users/demo/Notes';
export const MOD = 'ControlOrMeta';

export async function boot(page: Page): Promise<void> {
  await page.goto('/?stub=all');
  await expect(page.locator('.app.ready')).toBeVisible();
  await expect(page.locator('.stub-editor')).toHaveValue(/# Welcome to Margin/);
}

export const editorValue = (page: Page): Promise<string> => page.locator('.stub-editor').inputValue();

export const stubFile = (page: Page, path: string): Promise<string | undefined> =>
  page.evaluate((p) => {
    const v = window.__marginStub!.files.get(p);
    return typeof v === 'string' ? v : undefined;
  }, path);

export const queueDialog = (page: Page, path: string | null): Promise<void> =>
  page.evaluate((p) => void window.__marginStub!.dialogQueue.push(p), path);

export async function typeInEditor(page: Page, text: string): Promise<void> {
  const ed = page.locator('.stub-editor');
  await ed.focus();
  await page.keyboard.press(`${MOD}+End`);
  await page.keyboard.type(text);
}
