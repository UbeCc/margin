/**
 * Rich clipboard (#79): real ⌘C/⌘V through the engine's own pasteboard, plus
 * the flavours a copy writes. Runs on every configured project (chromium,
 * webkit on CI; PW_BROWSERS=chromium,webkit locally).
 */
import { expect, test, type Page } from '@playwright/test';
import { open, md, mod, docEnd } from './core-shared';

const SRC = '# Title\n\nSome **bold**, _it_, `code` and [a link](https://e.com).\n\n- one\n- two\n';

/** Select all editor content and copy with the real shortcut; returns flavours seen by the copy event. */
async function copyAll(page: Page): Promise<Record<string, string>> {
  await page.evaluate(() => {
    const w = window as unknown as { __copied: Record<string, string> };
    w.__copied = {};
    document.addEventListener(
      'copy',
      (e) => {
        // runs after the editor's handler (bubble phase on document)
        const dt = e.clipboardData!;
        for (const t of dt.types) w.__copied[t] = dt.getData(t);
      },
      { once: true },
    );
  });
  await page.locator('.md-editor').click();
  await page.keyboard.press(`${mod}+a`);
  await page.keyboard.press(`${mod}+c`);
  return page.evaluate(() => (window as unknown as { __copied: Record<string, string> }).__copied);
}

/** Paste with the real shortcut (at the current selection), recording the flavours the paste event exposed. */
async function pasteHere(page: Page): Promise<string[]> {
  await page.evaluate(() => {
    const w = window as unknown as { __pasted: string[] };
    w.__pasted = [];
    document.addEventListener('paste', (e) => void (w.__pasted = [...(e.clipboardData?.types ?? [])]), { capture: true, once: true });
  });
  await page.keyboard.press(`${mod}+v`);
  return page.evaluate(() => (window as unknown as { __pasted: string[] }).__pasted);
}

test.describe('rich clipboard (#79)', () => {
  test('copy writes markdown, rendered HTML with embedded md, and the private type', async ({ page }) => {
    await open(page, SRC, '&blocks=0');
    const c = await copyAll(page);
    // select-all covers the content, not the final newline
    const SEL = SRC.trimEnd();
    expect(c['text/plain']).toBe(SEL);
    expect(c['text/x-margin-markdown']).toBe(SEL);
    expect(c['text/html']).toContain('<strong>bold</strong>');
    expect(c['text/html']).toContain('href="https://e.com"');
    const embedded = await page.evaluate((h) => new DOMParser().parseFromString(h, 'text/html').querySelector('[data-margin-md]')?.getAttribute('data-margin-md'), c['text/html']);
    expect(embedded).toBe(SEL);
  });

  test('real copy → paste roundtrip is lossless', async ({ page, context, browserName }) => {
    if (browserName === 'chromium') await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await open(page, SRC, '&blocks=0');
    await copyAll(page);
    await page.keyboard.press(`${mod}+x`);
    expect((await md(page)).trim()).toBe('');
    const types = await pasteHere(page);
    // the private type survives the engine's real pasteboard in both chromium and webkit
    expect(types).toEqual(expect.arrayContaining(['text/plain', 'text/html', 'text/x-margin-markdown']));
    expect(await md(page)).toBe(SRC);
    // paste again at the end of the document: a second copy follows
    await page.keyboard.press(docEnd);
    await page.keyboard.press('Enter');
    await page.keyboard.press('Enter');
    await pasteHere(page);
    expect((await md(page)).split('# Title').length).toBe(3);
    void browserName;
  });

  test('a stripped private type falls back to markdown embedded in the HTML', async ({ page }) => {
    await open(page, 'x\n', '&blocks=0');
    await page.locator('.md-editor').click();
    await page.keyboard.press(docEnd);
    await page.evaluate((src) => {
      const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
      const dt = new DataTransfer();
      dt.setData('text/plain', 'flattened');
      dt.setData('text/html', `<meta charset="utf-8"><div data-margin-md="${esc(src)}"><p>rendered</p></div>`);
      document.querySelector('.md-editor')!.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
    }, ' **emb** & "q" <c>');
    expect(await md(page)).toBe('x **emb** & "q" <c>\n');
  });

  test('paste prefers private markdown over HTML and plain text', async ({ page }) => {
    await open(page, 'x\n', '&blocks=0');
    await page.locator('.md-editor').click();
    await page.keyboard.press(docEnd);
    await page.evaluate(() => {
      const dt = new DataTransfer();
      dt.setData('text/plain', 'PLAIN');
      dt.setData('text/html', '<p><b>HTML</b></p>');
      dt.setData('text/x-margin-markdown', ' **PRIV**');
      document.querySelector('.md-editor')!.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
    });
    expect(await md(page)).toBe('x **PRIV**\n');
  });

  test('rich copy carries the document URL as the WebArchive base (#115)', async ({ page }) => {
    const url = 'file:///Users/ubec/Notes/a%20b.md';
    await open(page, SRC, `&blocks=0&rich&docurl=${encodeURIComponent(url)}`);
    await copyAll(page);
    await expect.poll(() => page.evaluate(() => window.__core.rich.length)).toBe(1);
    expect(await page.evaluate(() => window.__core.rich[0].baseUrl)).toBe(url);
    // without a document the base is absent and the native side writes untitled.md
    await open(page, SRC, '&blocks=0&rich');
    await copyAll(page);
    await expect.poll(() => page.evaluate(() => window.__core.rich.length)).toBe(1);
    expect(await page.evaluate(() => window.__core.rich[0].baseUrl)).toBeUndefined();
  });

  test('macOS rich hook gets RTF + nonce after the copy event', async ({ page }) => {
    await open(page, SRC, '&blocks=0&rich');
    const c = await copyAll(page);
    await expect.poll(() => page.evaluate(() => window.__core.rich.length)).toBe(1);
    const r = await page.evaluate(() => window.__core.rich[0]);
    expect(r.markdown).toBe(SRC.trimEnd());
    expect(r.html).toBe(c['text/html']);
    expect(r.html).toContain(`data-margin-copy="${r.marker}"`);
    expect(r.rtf.startsWith('{\\rtf1')).toBe(true);
    expect(r.rtf).toContain('{\\b bold}');
    expect(r.rtf).toContain('HYPERLINK "https://e.com"');
  });
});
