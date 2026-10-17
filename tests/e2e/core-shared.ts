import { expect, type Page } from '@playwright/test';

export const DEV = '/src/editor/core/dev.html';
export const mod = process.platform === 'darwin' ? 'Meta' : 'Control';

export async function open(page: Page, md: string, extra = ''): Promise<void> {
  page.on('pageerror', (e) => console.log('pageerror', e.message));
  await page.goto(`${DEV}?md=${encodeURIComponent(md)}${extra}`);
  await expect(page.locator('#status')).toHaveText('ready');
}

export const md = (page: Page) => page.evaluate(() => window.__core.md());

/** Put the caret at content offset `off` of the n-th block (0-based) via the core's own mapping. */
export async function caret(page: Page, block: number, off: number): Promise<void> {
  await page.evaluate(
    ([b, o]) => {
      const blocks = document.querySelectorAll<HTMLElement>('.md-editor > .md-block');
      const content = blocks[b].querySelector<HTMLElement>('.md-content')!;
      content.closest<HTMLElement>('.md-editor')!.focus();
      // walk text nodes (skip [data-ns]) to find the offset
      let acc = 0;
      const w = document.createTreeWalker(content, NodeFilter.SHOW_TEXT);
      let n: Node | null;
      while ((n = w.nextNode())) {
        if ((n.parentElement as HTMLElement).closest('[data-ns]')) continue;
        const len = (n as Text).data.length;
        if (acc + len >= o) {
          getSelection()!.setBaseAndExtent(n, o - acc, n, o - acc);
          return;
        }
        acc += len;
      }
      getSelection()!.setBaseAndExtent(content, 0, content, 0);
    },
    [block, off],
  );
}

export const docEnd = process.platform === 'darwin' ? 'Meta+ArrowDown' : 'Control+End';
export const lineStart = process.platform === 'darwin' ? 'Meta+ArrowLeft' : 'Home';
