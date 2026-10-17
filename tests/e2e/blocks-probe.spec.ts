import { test, Page } from '@playwright/test';
import { open, md, mod } from './core-shared';
const lineEnd = () => (process.platform === 'darwin' ? 'Meta+ArrowRight' : 'End');

const W = (page: Page, t: string, i = 0) => page.locator(`.md-widget[data-type="${t}"]`).nth(i);
const cell = (page: Page, r: number, c: number, i = 0) => W(page, 'table', i).locator(`.mb-cell[data-r="${r}"][data-c="${c}"]`);
const log = (name: string, v: unknown) => console.log(`### ${name}: ${JSON.stringify(v)}`);

test('p1 fence: type closing fence inside body', async ({ page }) => {
  await open(page, 'a\n\n```js\nx\n```\n\nb\n');
  await W(page, 'code_fence').locator('.cm-content').click();
  await page.keyboard.press(`${mod}+End`);
  await page.keyboard.type('\n```\ny');
  await page.waitForTimeout(300);
  log('p1', await md(page));
  log('p1 widgets', await page.locator('.md-widget').count());
});

test('p2 table cell edit pretty', async ({ page }) => {
  await open(page, 'a\n\n| h1 | h2 |\n|----|----|\n| a  | b  |\n| c  | d  |\n\nb\n');
  await W(page, 'table').locator('.mb-cell').nth(2).click();
  await page.keyboard.press('End');
  await page.keyboard.type('XYZW');
  log('p2', await md(page));
});

test('p3 fence in list edit', async ({ page }) => {
  await open(page, '- item\n\n  ```js\n  x\n  ```\n- two\n');
  await W(page, 'code_fence').locator('.cm-content').click();
  await page.keyboard.press(`${mod}+End`);
  await page.keyboard.type('\ny');
  await page.waitForTimeout(200);
  log('p3', await md(page));
});

test('p4 math block edit + undo', async ({ page }) => {
  await open(page, 'a\n\n$$\nx^2\n$$\n\nb\n');
  await W(page, 'math_block').click();
  await page.waitForTimeout(200);
  await page.keyboard.press(`${mod}+End`);
  await page.keyboard.type('+1');
  await page.waitForTimeout(400);
  log('p4 after', await md(page));
  await page.keyboard.press('Escape');
  await page.keyboard.press(`${mod}+z`);
  await page.waitForTimeout(300);
  log('p4 undo', await md(page));
});

test('p5 table edit then source mode round trip', async ({ page }) => {
  await open(page, 'a\n\n|a|b|\n|-|-|\n|1|2|\n\nb\n');
  await W(page, 'table').locator('.mb-cell').nth(3).click();
  await page.keyboard.type('Q');
  const m1 = await md(page);
  await page.evaluate(() => window.__core.ed.setSourceMode(true));
  await page.evaluate(() => window.__core.ed.setSourceMode(false));
  log('p5', [m1, await md(page)]);
});

test('p6 html export xss', async ({ page }) => {
  await open(page, 'a\n\n<div><img src=x onerror="alert(1)"><script>alert(2)</script><a href="javascript:alert(3)">x</a></div>\n\nb\n');
  const html = await page.evaluate(() => window.__core.ed.renderHTML());
  log('p6', html.slice(0, 600));
});

test('p7 table tab nav and IME-ish', async ({ page }) => {
  await open(page, 'a\n\n|a|b|\n|-|-|\n|1|2|\n\nb\n');
  await W(page, 'table').locator('.mb-cell').nth(3).click();
  await page.keyboard.press('Tab');
  await page.keyboard.type('new');
  log('p7', await md(page));
  await page.keyboard.press(`${mod}+z`);
  await page.waitForTimeout(200);
  log('p7 undo', await md(page));
});

test('p8 arrows from paragraph into table and out', async ({ page }) => {
  await open(page, 'abc\n\n|a|b|\n|-|-|\n|1|2|\n\nxyz\n');
  await page.evaluate(() => window.__core.ed.exec({ kind: 'find', query: 'abc' }));
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('ArrowDown');
  await page.keyboard.type('H');
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('ArrowDown');
  await page.keyboard.type('Z');
  log('p8', await md(page));
});

test('p9 core inline html xss', async ({ page }) => {
  await open(page, 'a <img src=x onerror="window.__pwned=1"> b <a href="javascript:x">l</a> [m](javascript:alert(1))\n\n<img src=y onerror="window.__pwned=2">\n');
  await page.waitForTimeout(300);
  log('p9 pwned', await page.evaluate(() => (window as any).__pwned));
  log('p9 html', await page.evaluate(() => window.__core.ed.renderHTML()));
  log('p9 types', await page.locator('.md-block').evaluateAll((b) => b.map((x) => (x as HTMLElement).dataset.type)));
});

test('p10 escaped pipes', async ({ page }) => {
  await open(page, 'p\n\n| `a\\|b` | c \\| d |\n|---|---|\n| x | y |\n\nq\n');
  log('p10 cells', await W(page, 'table').locator('.mb-cell').allInnerTexts());
  await W(page, 'table').locator('.mb-cell').nth(3).click();
  await page.keyboard.type('Z');
  log('p10', await md(page));
  await W(page, 'table').locator('.mb-cell').nth(0).click();
  log('p10 editing text', await W(page, 'table').locator('.mb-cell').nth(0).innerText());
});

test('p11 paste TSV', async ({ page }) => {
  await open(page, 'p\n\n|a|b|\n|-|-|\n|1|2|\n\nq\n');
  await W(page, 'table').locator('.mb-cell').nth(2).click();
  await page.evaluate(() => {
    const dt = new DataTransfer(); dt.setData('text/plain', 'x\ty\nz\tw\n');
    document.activeElement!.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
  });
  log('p11', await md(page));
});

test('p13 undo in cell', async ({ page }) => {
  await open(page, 'p\n\n|a|b|\n|-|-|\n|1|2|\n\nq\n');
  await W(page, 'table').locator('.mb-cell').nth(2).click();
  await page.keyboard.press(lineEnd());
  await page.keyboard.type('ab');
  await page.keyboard.press(`${mod}+z`);
  await page.waitForTimeout(200);
  log('p13 undo md', await md(page));
  log('p13 cell', await W(page, 'table').locator('.mb-cell').nth(2).innerText());
  await page.keyboard.press(`${mod}+Shift+z`);
  await page.waitForTimeout(200);
  log('p13 redo md', await md(page));
});

test('p14 math in list', async ({ page }) => {
  await open(page, '- item $x^2$\n\n  $$\n  a+b\n  $$\n- two\n');
  log('p14 inline', await page.locator('.mb-inline-math, .katex').count());
  await W(page, 'math_block').click();
  await page.waitForTimeout(200);
  await page.keyboard.press(`${mod}+End`);
  await page.keyboard.type('+c');
  await page.waitForTimeout(400);
  log('p14', await md(page));
});

test('p15 front matter', async ({ page }) => {
  await open(page, '---\ntitle: x\n---\n\n# H\n');
  log('p15 types', await page.locator('.md-block').evaluateAll((b) => b.map((x) => (x as HTMLElement).dataset.type)));
  await W(page, 'front_matter').click();
  await page.waitForTimeout(200);
  await page.keyboard.press(`${mod}+End`);
  await page.keyboard.type('\ntags: [a]');
  await page.waitForTimeout(400);
  log('p15', await md(page));
});

test('p16 toc updates', async ({ page }) => {
  await open(page, '[toc]\n\n# One\n\n## Two\n');
  await page.waitForTimeout(300);
  log('p16 a', await W(page, 'toc').innerText());
  await page.evaluate(() => window.__core.ed.exec({ kind: 'find', query: 'Two' }));
  await page.keyboard.press('ArrowRight');
  await page.keyboard.type('X');
  await page.waitForTimeout(1200);
  log('p16 b', await W(page, 'toc').innerText());
});

test('p17 fence lang -> mermaid', async ({ page }) => {
  await open(page, 'p\n\n```\ngraph TD; A-->B\n```\n\nq\n');
  await W(page, 'code_fence').hover();
  await W(page, 'code_fence').locator('.mb-lang').fill('mermaid');
  await page.waitForTimeout(1500);
  log('p17', [await md(page), await page.locator('.md-block').evaluateAll((b) => b.map((x) => (x as HTMLElement).dataset.type))]);
});

test('p19 arrows math/html', async ({ page }) => {
  await open(page, 'abc\n\n$$\nx\n$$\n\n<div>h</div>\n\nxyz\n');
  await page.evaluate(() => window.__core.ed.exec({ kind: 'find', query: 'abc' }));
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('ArrowDown');
  await page.keyboard.type('1');
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('ArrowDown');
  await page.keyboard.type('2');
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('ArrowDown');
  await page.keyboard.type('3');
  await page.waitForTimeout(400);
  log('p19', await md(page));
});

test('p20 backspace empty fence', async ({ page }) => {
  await open(page, 'p\n\n```\n```\n\nq\n');
  await W(page, 'code_fence').locator('.cm-content').click();
  await page.keyboard.press('Backspace');
  await page.keyboard.type('W');
  log('p20', await md(page));
});

test('p21 math exit down to html', async ({ page }) => {
  await open(page, 'abc\n\n$$\nx\n$$\n\n<div>h</div>\n\nxyz\n');
  const ae = () => page.evaluate(() => { const a = document.activeElement as HTMLElement; return a.className + ' | ' + (a.closest('.md-block') as HTMLElement)?.dataset.type; });
  await W(page, 'math_block').click();
  await page.waitForTimeout(200);
  log('p21 a', await ae());
  await page.keyboard.press('ArrowDown');
  await page.waitForTimeout(100);
  log('p21 b', await ae());
  await page.keyboard.press('ArrowDown');
  await page.waitForTimeout(100);
  log('p21 c', await ae());
  await page.locator('.md-block').first().click();
  await page.keyboard.press('ArrowDown');
  log('p21 d', await ae());
  await page.keyboard.press('ArrowDown');
  log('p21 e', await ae());
});

test('p22 math $$ typed inside', async ({ page }) => {
  await open(page, 'a\n\n$$\nx\n$$\n\nb\n');
  await W(page, 'math_block').click();
  await page.waitForTimeout(200);
  await page.keyboard.press(`${mod}+End`);
  await page.keyboard.type('\n$$\ny');
  await page.waitForTimeout(400);
  log('p22', [await md(page), await page.locator('.md-block').evaluateAll((b) => b.map((x) => (x as HTMLElement).dataset.type))]);
});

test('p23 fence variants in quote and tab key', async ({ page }) => {
  await open(page, '> ```py {.numberLines}\n> def f():\n> \tpass\n> ```\n\nb\n');
  log('p23 types', await page.locator('.md-block').evaluateAll((b) => b.map((x) => (x as HTMLElement).dataset.type)));
  await W(page, 'code_fence').locator('.cm-content').click();
  await page.keyboard.press(`${mod}+End`);
  await page.keyboard.press('Enter');
  await page.keyboard.press('Tab');
  await page.keyboard.type('x');
  await page.waitForTimeout(200);
  log('p23', await md(page));
  log('p23 lang', await W(page, 'code_fence').locator('.mb-lang').inputValue());
});

test('p24 renderHTML validity', async ({ page }) => {
  await open(page, '```html\n</code></pre><script>window.__p=1</script>\n```\n\n$$\n\\frac{a}{b} \\label{eq}\n$$\n\n$$\n\\bad{\n$$\n\n| a<br>b | `<i>` |\n|---|---|\n| [l](javascript:x) | ![i](x.png) |\n\n[toc]\n\n# H <x>\n\n```mermaid\ngraph TD; A-->B\n```\n');
  await page.waitForTimeout(1500);
  const html = await page.evaluate(() => window.__core.ed.renderHTML());
  log('p24', html.replace(/<span class="katex[\s\S]*?<\/annotation>/g, '[katex]').slice(0, 2500));
});

test('p25 undo across fence edits', async ({ page }) => {
  await open(page, 'a\n\n```\nx\n```\n\nb\n');
  await W(page, 'code_fence').locator('.cm-content').click();
  await page.keyboard.press(`${mod}+End`);
  await page.keyboard.type('yz');
  await page.keyboard.press('Escape');
  await page.keyboard.type('Q');
  log('p25 a', await md(page));
  await page.keyboard.press(`${mod}+z`);
  log('p25 b', await md(page));
  await page.keyboard.press(`${mod}+z`);
  await page.waitForTimeout(100);
  log('p25 c', await md(page));
  await page.keyboard.press(`${mod}+Shift+z`);
  await page.waitForTimeout(100);
  log('p25 d', await md(page));
  log('p25 cm', await W(page, 'code_fence').locator('.cm-content').innerText());
});

test('p26 big code perf', async ({ page }) => {
  const body = Array.from({ length: 5000 }, (_, i) => `const v${i} = ${i}; // line`).join('\n');
  const doc = Array.from({ length: 30 }, (_, i) => `para ${i}\n\n\`\`\`js\n${i === 0 ? body : 'x'}\n\`\`\`\n`).join('\n');
  const t0 = Date.now();
  await open(page, doc);
  log('p26 load ms', Date.now() - t0);
  const t1 = Date.now();
  await W(page, 'code_fence').locator('.cm-content').click();
  await page.keyboard.type('abc');
  log('p26 type ms', Date.now() - t1);
  log('p26 len', (await md(page)).length);
});

test('p27 many diagrams', async ({ page }) => {
  const doc = Array.from({ length: 25 }, (_, i) => `## d${i}\n\n\`\`\`mermaid\ngraph TD; A${i}-->B${i}\n\`\`\`\n`).join('\n');
  const t0 = Date.now();
  await open(page, doc);
  await page.waitForFunction(() => document.querySelectorAll('.md-widget[data-type="diagram"] svg').length >= 25, null, { timeout: 20000 }).catch(() => {});
  log('p27 ms', [Date.now() - t0, await page.locator('.md-widget[data-type="diagram"] svg').count()]);
  await page.evaluate(() => (window.__core.ed as any).updateSettings?.({ colorScheme: 'dark' }));
});

test('p28 redo focus', async ({ page }) => {
  await open(page, 'a\n\n```\nx\n```\n\nb\n');
  const ae = () => page.evaluate(() => { const a = document.activeElement as HTMLElement; return a.className + ' | ' + (a.closest('.md-block') as HTMLElement)?.dataset.type; });
  await W(page, 'code_fence').locator('.cm-content').click();
  await page.keyboard.press(`${mod}+End`);
  await page.keyboard.type('yz');
  await page.keyboard.press('Escape');
  log('p28 0', await ae());
  await page.keyboard.press(`${mod}+z`);
  await page.waitForTimeout(100);
  log('p28 1', [await md(page), await ae()]);
  await page.keyboard.press(`${mod}+Shift+z`);
  await page.waitForTimeout(100);
  log('p28 2', [await md(page), await ae()]);
  await page.evaluate(() => window.__core.ed.exec({ kind: 'redo' }));
  log('p28 3', await md(page));
});

test('p26b big code perf', async ({ page }) => {
  await open(page, 'x\n');
  const body = Array.from({ length: 5000 }, (_, i) => `const v${i} = ${i}; // line`).join('\n');
  const doc = Array.from({ length: 30 }, (_, i) => `para ${i}\n\n\`\`\`js\n${i === 0 ? body : 'x'}\n\`\`\`\n`).join('\n');
  const t0 = await page.evaluate((d) => { const t = performance.now(); window.__core.ed.setMarkdown(d); return performance.now() - t; }, doc);
  log('p26 setMarkdown ms', t0);
  const t1 = Date.now();
  await W(page, 'code_fence').locator('.cm-content').click();
  await page.keyboard.type('abc');
  log('p26 type ms', Date.now() - t1);
  log('p26 ok', (await md(page)).includes('abcconst v0') || (await md(page)).slice(0, 200));
});

test('p30 source roundtrip after widget edits', async ({ page }) => {
  const doc = '---\nt: 1\n---\n\n# H\n\n[toc]\n\n```js {.numberLines}\nx\n```\n\n~~~~\nraw ``` inside\n~~~~\n\n$$\na\n$$\n\n| a | b |\n|:-:|--:|\n| `x\\|y` | 2 |\n\n<details>\n<summary>s</summary>\nbody\n</details>\n\n```mermaid\ngraph TD; A-->B\n```\n\n- list\n  ```\n  in list\n  ```\n> quote\n> $$\n> q\n> $$\n';
  await open(page, doc);
  await page.waitForTimeout(500);
  log('p30 same', (await md(page)) === doc);
  await page.evaluate(() => window.__core.ed.setSourceMode(true));
  await page.evaluate(() => window.__core.ed.setSourceMode(false));
  await page.waitForTimeout(300);
  log('p30 rt', (await md(page)) === doc);
  log('p30 types', await page.locator('.md-editor > .md-block').evaluateAll((b) => b.map((x) => (x as HTMLElement).dataset.type).join(',')));
  // edit the quoted math
  await W(page, 'math_block', 1).click();
  await page.waitForTimeout(200);
  await page.keyboard.press(`${mod}+End`);
  await page.keyboard.type('+r');
  await page.waitForTimeout(300);
  const m = await md(page);
  log('p30 quote math', m.slice(m.indexOf('> quote')));
});

test('p31 diagram error and theme in core', async ({ page }) => {
  await open(page, 'a\n\n```mermaid\ngraph TD; A-->\n```\n\n```sequence\nA->B: hi\n```\n\n```flow\nst=>start: Start\ne=>end\nst->e\n```\n');
  await page.waitForTimeout(2500);
  log('p31 err', await W(page, 'diagram', 0).innerText());
  log('p31 svgs', await page.locator('.md-widget[data-type="diagram"] svg').count());
  log('p31 seq', (await W(page, 'diagram', 1).innerHTML()).slice(0, 200));
});

test('p32 toc click & export ids', async ({ page }) => {
  await open(page, '[toc]\n\n# One\n\n' + 'filler\n\n'.repeat(80) + '## Two `code` *em*\n');
  await page.waitForTimeout(400);
  log('p32 toc', await W(page, 'toc').innerText());
  await W(page, 'toc').locator('a', { hasText: 'Two' }).click();
  await page.waitForTimeout(400);
  log('p32 scroll', await page.evaluate(() => window.scrollY));
});

test('p33 front matter edge', async ({ page }) => {
  await open(page, '---\n---\n\nbody\n');
  log('p33 types', await page.locator('.md-block').evaluateAll((b) => b.map((x) => (x as HTMLElement).dataset.type)));
  log('p33 html', await page.evaluate(() => window.__core.ed.renderHTML()));
});

test('p34 mermaid leftovers', async ({ page }) => {
  await open(page, 'a\n\n```mermaid\ngraph TD; A-->B\n```\n');
  await page.waitForTimeout(1500);
  const before = await page.evaluate(() => [...document.body.children].map((c) => c.tagName + '#' + c.id).join(','));
  await W(page, 'diagram').click();
  await page.waitForTimeout(200);
  await page.keyboard.press(`${mod}+End`);
  for (const ch of ' --> {{bad') { await page.keyboard.type(ch); await page.waitForTimeout(60); }
  await page.waitForTimeout(1500);
  log('p34 body', [before, await page.evaluate(() => [...document.body.children].map((c) => c.tagName + '#' + c.id).join(','))]);
  log('p34 widget', (await W(page, 'diagram').innerText()).slice(0, 120));
  log('p34 export', (await page.evaluate(() => window.__core.ed.renderHTML())).slice(0, 200));
});

test('p40 table edges', async ({ page }) => {
  await open(page, 'p\n\n|a|b|\n|-|-|\n\nq\n');
  log('p40 rows', await W(page, 'table').locator('tr').count());
  await cell(page, 0, 1).click();
  await page.keyboard.press('Enter');
  await page.keyboard.type('n');
  log('p40 enter header-only', await md(page));
  await page.keyboard.press(`${mod}+a`);
  await page.keyboard.type('sel');
  log('p40 selectall', await md(page));
  await cell(page, 0, 0).click();
  await page.keyboard.press('ArrowUp');
  await page.keyboard.type('U');
  log('p40 up exit', await md(page));
});

test('p41 delete header row / all-empty backspace', async ({ page }) => {
  await open(page, 'p\n\n|a|b|\n|-|-|\n|1|2|\n\nq\n');
  await cell(page, 0, 0).click();
  await W(page, 'table').locator('.mb-row-del').click();
  log('p41 del header', await md(page));
  await open(page, 'p\n\n| | |\n|-|-|\n| | |\n\nq\n');
  await cell(page, 1, 1).click();
  await page.keyboard.press('Backspace');
  await page.keyboard.type('Z');
  log('p41 empty bs', await md(page));
});

test('p42 shift-enter br and click caret', async ({ page }) => {
  await open(page, 'p\n\n|a|b|\n|-|-|\n|**bold** text|2|\n\nq\n');
  const c = cell(page, 1, 0);
  const box = (await c.locator('strong').boundingBox())!;
  await page.mouse.click(box.x + box.width - 2, box.y + box.height / 2);
  await page.waitForTimeout(50);
  await page.keyboard.type('X');
  log('p42 click map', await md(page));
  await page.keyboard.press('Shift+Enter');
  await page.keyboard.type('Y');
  log('p42 br', await md(page));
  await cell(page, 1, 1).click();
  log('p42 rendered br', await c.innerHTML());
});

test('p43 mod keys in cell', async ({ page }) => {
  await open(page, 'p\n\n|a|b|\n|-|-|\n|one|2|\n\nq\n');
  await cell(page, 1, 0).click();
  await page.keyboard.press(`${mod}+a`);
  await page.keyboard.press(`${mod}+b`);
  await page.waitForTimeout(100);
  log('p43 bold md', await md(page));
  log('p43 bold dom', await cell(page, 1, 0).innerHTML());
  await page.keyboard.press(`${mod}+i`);
  await page.keyboard.press('End');
  await page.keyboard.type('Z');
  log('p43 after', await md(page));
  await cell(page, 0, 0).click();
  await page.keyboard.press('ArrowUp');
  await page.keyboard.type('U');
  log('p43 up exit', await md(page));
});

test('p44 theme switch', async ({ page }) => {
  await open(page, 'a\n\n```js\nconst x=1\n```\n\n```mermaid\ngraph TD; A-->B\n```\n\n|a|\n|-|\n|1|\n\n$$\nx\n$$\n');
  await page.waitForTimeout(1500);
  const fill = () => page.evaluate(() => getComputedStyle(document.querySelector('.md-widget[data-type="diagram"] svg .node rect, .md-widget[data-type="diagram"] svg rect')!).fill);
  const f1 = await fill();
  await page.evaluate(() => window.__core.ed.updateSettings({ colorScheme: 'dark' }));
  await page.waitForTimeout(1500);
  log('p44', [f1, await fill(), await page.locator('.mb-block[data-scheme="dark"]').count(), await page.locator('.mb-block').count()]);
  log('p44 cm dark', await page.locator('.md-widget[data-type="code_fence"] .cm-editor').evaluate((e) => getComputedStyle(e).backgroundColor + ' ' + getComputedStyle(e.querySelector('.cm-content')!).color));
});

test('p45 arrow left/right into widgets', async ({ page }) => {
  await open(page, 'ab\n\n```\ncode\n```\n\ncd\n');
  await page.evaluate(() => window.__core.ed.exec({ kind: 'find', query: 'ab' }));
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('ArrowRight');
  await page.keyboard.type('1');
  await page.keyboard.press(`${mod}+End`);
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('ArrowRight');
  await page.keyboard.type('2');
  await page.keyboard.press('ArrowLeft');
  await page.keyboard.press('ArrowLeft');
  await page.keyboard.press('ArrowLeft');
  await page.keyboard.type('3');
  log('p45', await md(page));
});

test('p46 table in quote/list', async ({ page }) => {
  await open(page, '> | a | b |\n> |---|---|\n> | 1 | 2 |\n\n- item\n\n  | x | y |\n  |---|---|\n  | 3 | 4 |\n');
  log('p46 types', await page.locator('.md-block').evaluateAll((b) => b.map((x) => (x as HTMLElement).dataset.type)));
  await cell(page, 1, 1, 0).click();
  await page.keyboard.type('Q');
  await cell(page, 1, 1, 1).click();
  await page.keyboard.type('R');
  await page.keyboard.press('Tab');
  await page.keyboard.type('S');
  log('p46', await md(page));
});

test('p47 focus/blur without edits keeps source', async ({ page }) => {
  const doc = 'p\n\n|  a |b|\n|:--|--:|\n| **x** |  y  |\n\nq\n';
  await open(page, doc);
  for (const [r, c] of [[0, 0], [1, 0], [1, 1], [0, 1]]) await cell(page, r, c).click();
  await page.keyboard.press('Escape');
  log('p47', [(await md(page)) === doc, await page.evaluate(() => window.__core.changes)]);
});

import { fixtureEntries, ROOT } from './app-fixture';
test('p50 real app', async ({ page }) => {
  const doc = '# W\n\n[toc]\n\n```js\nconst a = 1;\n```\n\n$$\nx^2 \\label{a}\n$$\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n```mermaid\ngraph TD; A-->B\n```\n\n<div><b>h</b></div>\n';
  const errs: string[] = [];
  page.on('pageerror', (e) => errs.push(e.message));
  page.on('console', (m) => m.type() === 'error' && errs.push(m.text()));
  await page.addInitScript((entries) => localStorage.setItem('margin.web.fs.v1', JSON.stringify(entries)), fixtureEntries({ [`${ROOT}/Welcome.md`]: doc }));
  await page.goto(`/?folder=${encodeURIComponent(ROOT)}`);
  await page.waitForTimeout(2500);
  log('p50 widgets', await page.locator('.md-widget').evaluateAll((b) => b.map((x) => (x as HTMLElement).dataset.type)));
  log('p50 svg', await page.locator('.md-widget svg').count());
  await page.locator('.md-widget[data-type="table"] .mb-cell').nth(3).click();
  await page.keyboard.type('Z');
  const tools = await page.locator('.mb-table-tools').boundingBox();
  log('p50 tools', tools);
  await page.screenshot({ path: '/tmp/qb-app.png', fullPage: false });
  log('p50 errs', errs.slice(0, 5));
});

test('p51 click caret in cell', async ({ page }) => {
  await open(page, 'p\n\n| aaaa | b |\n|---|---|\n| 1 | longer text here |\n');
  for (const [r, c] of [[1, 0], [1, 1], [0, 0]] as const) {
    const box = (await cell(page, r, c).boundingBox())!;
    await page.mouse.click(box.x + box.width - 3, box.y + box.height / 2);
    await page.waitForTimeout(50);
    await page.keyboard.type('Z');
  }
  const box = (await cell(page, 1, 1).boundingBox())!;
  log('p51', await md(page));
});

test('p52 big table perf', async ({ page }) => {
  await open(page, 'x\n');
  const rows = Array.from({ length: 1000 }, (_, i) => `| r${i} | **v${i}** | \`c${i}\` | $x_${i}$ |`).join('\n');
  const doc = `p\n\n| a | b | c | d |\n|---|---|---|---|\n${rows}\n`;
  const t = await page.evaluate((d) => { const t0 = performance.now(); window.__core.ed.setMarkdown(d); return performance.now() - t0; }, doc);
  log('p52 load', t);
  await cell(page, 500, 1).click();
  const t1 = Date.now();
  await page.keyboard.type('abcdefghij');
  log('p52 type10', Date.now() - t1);
  const t2 = Date.now();
  await page.keyboard.press(`${mod}+Enter`);
  log('p52 insertrow', Date.now() - t2);
});
