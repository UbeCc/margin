/** #61: exported code blocks (`pre.md-fences`, no `.mb-block` wrapper) keep syntax colours. */
import { expect, test } from '@playwright/test';
import { readFileSync } from 'node:fs';

const css = readFileSync(new URL('../../src/editor/blocks/blocks.css', import.meta.url), 'utf8');
const doc = (scheme = '') =>
  `<style>${css}</style><pre class="md-fences" lang="js"${scheme}><code class="language-js"><span class="tok-keyword">const</span> a = <span class="tok-string">"s"</span>; <span class="tok-comment">// c</span></code></pre>`;
const color = (page: import('@playwright/test').Page, sel: string) => page.locator(sel).evaluate((e) => getComputedStyle(e).color);

test.describe('export CSS (#61)', () => {
  test('tok-* colours apply to exported fences (light and dark)', async ({ page }) => {
    await page.setContent(`<body style="color: rgb(1, 2, 3)">${doc()}</body>`);
    expect(await color(page, '.tok-keyword')).toBe('rgb(207, 34, 46)');
    expect(await color(page, '.tok-string')).toBe('rgb(10, 48, 105)');
    expect(await page.locator('.tok-comment').evaluate((e) => getComputedStyle(e).fontStyle)).toBe('italic');
    await page.setContent(`<body>${doc(' data-scheme="dark"')}</body>`);
    expect(await color(page, '.tok-keyword')).toBe('rgb(255, 123, 114)');
  });
});
