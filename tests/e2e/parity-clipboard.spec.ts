/**
 * Parity epic #96: Edit › Copy as / Paste as Plain Text / Selection / Delete
 * scopes / Jump To / Find options, plus rich copy (#79). One test per surface;
 * titles carry the surface id for the parity ledger binding.
 *
 * Commands run from a real key press (an F2 hook calls `ed.exec`), so the
 * engine grants `execCommand('copy')` like it does for a native menu item; the
 * result is read back through a real ⌘V into a scratch contenteditable.
 */
import { expect, test, type Page } from '@playwright/test';
import type { EditorCommand } from '../../src/contracts';
import { open, md, mod, caret } from './core-shared';
import { boot, caretAtText, editorValue, MOD } from './app-helpers';

/** Run `cmd` from a genuine key press (user activation), like a menu click. */
async function run(page: Page, cmd: EditorCommand): Promise<boolean> {
  await page.evaluate((c) => {
    const w = window as unknown as { __res?: boolean; __cmd: EditorCommand; __hooked?: boolean };
    w.__cmd = c;
    w.__res = undefined;
    if (w.__hooked) return;
    w.__hooked = true;
    document.addEventListener(
      'keydown',
      (e) => {
        if (e.key !== 'F2') return;
        e.preventDefault();
        w.__res = window.__core.ed.exec(w.__cmd);
      },
      true,
    );
  }, cmd);
  await page.keyboard.press('F2');
  return page.evaluate(() => (window as unknown as { __res: boolean }).__res);
}

/** Paste the system clipboard into a scratch field (real ⌘V); returns every flavour the paste exposed. */
async function clipboard(page: Page): Promise<Record<string, string>> {
  await page.evaluate(() => {
    const w = window as unknown as { __clip: Record<string, string> };
    w.__clip = {};
    const sink = document.createElement('div');
    sink.id = 'sink';
    sink.contentEditable = 'true';
    document.body.append(sink);
    sink.addEventListener('paste', (e) => {
      e.preventDefault();
      for (const t of e.clipboardData!.types) w.__clip[t] = e.clipboardData!.getData(t);
    });
    sink.focus();
  });
  await page.keyboard.press(`${mod}+v`);
  const got = await page.evaluate(() => (window as unknown as { __clip: Record<string, string> }).__clip);
  await page.evaluate(() => document.getElementById('sink')?.remove());
  return got;
}

/** Select the whole document text with ⌘A inside the editor. */
async function selectAll(page: Page): Promise<void> {
  await page.locator('.md-editor').click();
  await page.keyboard.press(`${mod}+a`);
}

const SRC = '# Title\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\nSome **bold** and `code`.\n';

test.describe('parity: clipboard & selection (#96)', () => {
  test('menu.edit.copy-as: Edit › Copy as Markdown / HTML Code / Plain Text / without Theme Styling / to MS Word', async ({ page, context, browserName }) => {
    if (browserName === 'chromium') await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await open(page, SRC);
    await selectAll(page);
    expect(await run(page, { kind: 'copyAs', format: 'markdown' })).toBe(true);
    let c = await clipboard(page);
    expect(c['text/plain']).toBe(SRC.trimEnd());
    expect(c['text/html']).toBeUndefined();

    await selectAll(page);
    await run(page, { kind: 'copyAs', format: 'html' });
    c = await clipboard(page);
    expect(c['text/plain']).toContain('<strong>bold</strong>');
    expect(c['text/plain']).toContain('<h1');
    expect(c['text/html']).toBeUndefined();

    await selectAll(page);
    await run(page, { kind: 'copyAs', format: 'plain' });
    c = await clipboard(page);
    expect(c['text/plain']).toContain('Title\n\na\tb\n1\t2\n\nSome bold and code.');
    expect(c['text/plain']).not.toContain('**');

    await selectAll(page);
    await run(page, { kind: 'copyAs', format: 'unstyled' });
    c = await clipboard(page);
    expect(c['text/html']).toContain('<strong>bold</strong>');
    expect(c['text/html']).not.toContain('style=');
    expect(c['text/html']).not.toContain('data-margin-md');
    expect(c['text/plain']).not.toContain('**');
    expect(c['text/x-margin-markdown']).toBeUndefined();

    await selectAll(page);
    await run(page, { kind: 'copyAs', format: 'word' });
    c = await clipboard(page);
    expect(c['text/html']).toMatch(/<h1[^>]*style="font-size:24pt/);

    // negative: nothing selected → nothing copied, the command reports false
    await caret(page, 0, 3);
    expect(await run(page, { kind: 'copyAs', format: 'markdown' })).toBe(false);
  });

  test('menu.edit.copy-as: math as TeX / MathML and Copy Image', async ({ page, context, browserName }) => {
    if (browserName === 'chromium') await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await open(page, 'Inline $a^2+b^2$ here.\n\n$$\n\\frac{1}{2}\n$$\n');
    await caret(page, 0, 10);
    expect(await run(page, { kind: 'copyAs', format: 'tex' })).toBe(true);
    expect((await clipboard(page))['text/plain']).toBe('a^2+b^2');
    await caret(page, 0, 10);
    await run(page, { kind: 'copyAs', format: 'mathml' });
    const mml = (await clipboard(page))['text/plain'];
    expect(mml).toMatch(/^<math[^>]*xmlns="http:\/\/www\.w3\.org\/1998\/Math\/MathML"/);
    expect(mml).toContain('<msup>');
    // caret outside any math: refused
    await caret(page, 0, 2);
    expect(await run(page, { kind: 'copyAs', format: 'tex' })).toBe(false);
    expect(await run(page, { kind: 'copyAs', format: 'image' })).toBe(false);
  });

  test('menu.edit.paste-plain: Edit › Paste as Plain Text', async ({ page, context, browserName }) => {
    if (browserName === 'chromium') await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await open(page, 'Some **bold** text\n\nend\n', '&blocks=0' + (browserName === 'webkit' ? '&clipread' : ''));
    // a Margin copy (private md + HTML flavours) of the whole document
    await selectAll(page);
    await page.keyboard.press(`${mod}+c`);
    if (browserName === 'webkit') {
      // WebKit refuses script clipboard reads outside its paste callout: the desktop app reads the
      // pasteboard natively (clipboard_read); the harness stands in for that bridge with the same flavours
      await page.evaluate(() => {
        const md = window.__core.md().trimEnd();
        window.__core.clip = { plain: md, html: `<div data-margin-md="x"><p>Some <strong>bold</strong> text</p><p>end</p></div>`, rtfHtml: null };
      });
    }
    const PLAIN = 'Some **bold** text\n\nend\n\nSome bold text\n\nend\n';
    await caret(page, 1, 3);
    expect(await run(page, { kind: 'pastePlain' })).toBe(true);
    await expect.poll(() => md(page)).toBe(PLAIN);
    // undoable in one step
    await page.keyboard.press(`${mod}+z`);
    await expect.poll(() => md(page)).toBe('Some **bold** text\n\nend\n');
    if (browserName === 'chromium' && process.platform === 'linux') {
      // keyboard: Chromium's own paste-and-match-style (Ctrl+Shift+V) is taken as plain
      await caret(page, 1, 3);
      await page.keyboard.press('Control+Shift+v');
      await expect.poll(() => md(page)).toBe(PLAIN);
      await page.keyboard.press(`${mod}+z`);
    }
    // a normal ⌘V still pastes rich markdown
    await caret(page, 1, 3);
    await page.keyboard.press(`${mod}+v`);
    await expect.poll(() => md(page)).toBe('Some **bold** text\n\nend\n\nSome **bold** text\n\nend\n');
    // negative: an empty clipboard inserts nothing
    if (browserName === 'webkit') {
      await page.evaluate(() => (window.__core.clip = { plain: '', html: null, rtfHtml: null }));
      const before = await md(page);
      await caret(page, 0, 1);
      await run(page, { kind: 'pastePlain' });
      await page.waitForTimeout(50);
      expect(await md(page)).toBe(before);
    }
  });

  test('beh.clip.rtf-paste: Paste RTF/RTFD from rich apps (attachments materialized)', async ({ page }) => {
    await open(page, 'x\n', '&blocks=0&clipread');
    // a rich app's clipboard: plain text for the web engine, RTF that only the native side can read
    await page.evaluate(() => {
      const ta = document.createElement('textarea');
      ta.id = 'src';
      ta.value = 'Bold rich';
      document.body.append(ta);
      ta.select();
    });
    await page.keyboard.press(`${mod}+c`);
    await page.evaluate(() => {
      document.getElementById('src')!.remove();
      window.__core.clip = { plain: 'Bold rich', html: null, rtfHtml: '<html><body><p><b>Bold</b> <i>rich</i></p></body></html>' };
    });
    await caret(page, 0, 1);
    await page.keyboard.press(`${mod}+v`);
    await expect.poll(() => md(page)).toBe('x**Bold** *rich*\n');
    // no RTF from the native side: the plain text is pasted
    await page.evaluate(() => (window.__core.clip = { plain: 'Bold rich', html: null, rtfHtml: null }));
    await page.keyboard.press(`${mod}+v`);
    await expect.poll(() => md(page)).toBe('x**Bold** *rich*Bold rich\n');
  });

  test('menu.edit.select-scopes: Edit › Selection: Select Word / Line-Sentence / Paragraph-Block / Styled Scope', async ({ page }) => {
    const S = 'Alpha beta. Gamma **delta eps** zeta.\n\n- item one\n- item two\n';
    await open(page, S, '&blocks=0');
    const selectThenType = async (block: number, off: number, cmd: EditorCommand, typed = 'X') => {
      await page.evaluate((s) => window.__core.ed.setMarkdown(s), S);
      await caret(page, block, off);
      const ok = await run(page, cmd);
      if (ok) await page.keyboard.type(typed);
      return ok;
    };
    expect(await selectThenType(0, 8, { kind: 'select', scope: 'word' })).toBe(true);
    expect(await md(page)).toBe(S.replace('beta', 'X'));
    expect(await selectThenType(0, 14, { kind: 'select', scope: 'line' })).toBe(true);
    expect(await md(page)).toBe(S.replace('Gamma **delta eps** zeta.', 'X'));
    expect(await selectThenType(0, 22, { kind: 'select', scope: 'styled' })).toBe(true);
    expect(await md(page)).toBe(S.replace('**delta eps**', '**X**'));
    expect(await selectThenType(0, 2, { kind: 'select', scope: 'block' })).toBe(true);
    expect(await md(page)).toBe(S.replace('Alpha beta. Gamma **delta eps** zeta.', 'X'));
    // block inside a list item keeps the hidden marker
    expect(await selectThenType(1, 3, { kind: 'select', scope: 'block' })).toBe(true);
    expect(await md(page)).toBe(S.replace('item one', 'X'));
    // negatives: no word between two spaces, no styled run around plain text
    await page.evaluate(() => window.__core.ed.setMarkdown('a  b\n'));
    await caret(page, 0, 2);
    expect(await run(page, { kind: 'select', scope: 'word' })).toBe(false);
    expect(await run(page, { kind: 'select', scope: 'styled' })).toBe(false);
  });

  test('menu.edit.delete-scopes: Edit › Delete Word / Line-Sentence / Paragraph-Block / Styled Scope / Range', async ({ page }) => {
    const S = 'One two three. Four *five* six.\n\nSecond para.\n\nThird.\n';
    await open(page, S, '&blocks=0');
    const del = async (block: number, off: number, scope: 'word' | 'line' | 'block' | 'styled' | 'range') => {
      await page.evaluate((s) => window.__core.ed.setMarkdown(s), S);
      await caret(page, block, off);
      return run(page, { kind: 'delete', scope });
    };
    await del(0, 5, 'word');
    expect(await md(page)).toBe(S.replace('two ', ''));
    await page.keyboard.press(`${mod}+z`);
    expect(await md(page)).toBe(S);
    await del(0, 17, 'line');
    expect(await md(page)).toBe(S.replace(' Four *five* six.', ''));
    await del(0, 23, 'styled');
    expect(await md(page)).toBe(S.replace('*five* ', ''));
    await del(1, 3, 'block');
    expect(await md(page)).toBe('One two three. Four *five* six.\n\nThird.\n');
    await page.keyboard.press(`${mod}+z`);
    expect(await md(page)).toBe(S);
    await del(2, 1, 'block'); // last block: the separator before it goes too
    expect(await md(page)).toBe('One two three. Four *five* six.\n\nSecond para.\n');
    // Delete Range removes the selection; refused without one
    expect(await del(0, 3, 'range')).toBe(false);
    await caret(page, 0, 0);
    for (let k = 0; k < 4; k++) await page.keyboard.press('Shift+ArrowRight');
    expect(await run(page, { kind: 'delete', scope: 'range' })).toBe(true);
    expect(await md(page)).toBe(S.replace('One ', ''));
  });

  test('beh.clip.rich-copy: Rich copy writes plain + HTML + RTF + private format', async ({ page }) => {
    await open(page, SRC, '&blocks=0&rich');
    await selectAll(page);
    const flavours = await page.evaluate(
      () =>
        new Promise<Record<string, string>>((res) => {
          document.addEventListener('copy', (e) => res(Object.fromEntries(e.clipboardData!.types.map((t) => [t, e.clipboardData!.getData(t)]))), { once: true });
          document.execCommand('copy');
        }),
    );
    expect(flavours['text/plain']).toBe(SRC.trimEnd());
    expect(flavours['text/x-margin-markdown']).toBe(SRC.trimEnd());
    expect(flavours['text/html']).toContain('<strong>bold</strong>');
    await expect.poll(() => page.evaluate(() => window.__core.rich.length)).toBe(1);
    const rich = await page.evaluate(() => window.__core.rich[0]);
    expect(rich.rtf.startsWith('{\\rtf1')).toBe(true);
    expect(rich.rtf).toContain('\\b ');
    expect(rich.html).toContain(rich.marker);
  });

  test('menu.edit.jump: Edit › Jump To: Top / Bottom / Selection', async ({ page }) => {
    const S = Array.from({ length: 80 }, (_, k) => `Paragraph ${k} text.`).join('\n\n') + '\n';
    await open(page, S, '&blocks=0');
    await caret(page, 40, 3);
    await page.keyboard.press('Shift+End');
    await run(page, { kind: 'jump', to: 'bottom' });
    await page.keyboard.type('!');
    expect((await md(page)).endsWith('Paragraph 79 text.!\n')).toBe(true);
    await run(page, { kind: 'jump', to: 'top' });
    await page.keyboard.type('^');
    expect((await md(page)).startsWith('^Paragraph 0')).toBe(true);
    // jump back to a selection that scrolled out of view
    await caret(page, 40, 0);
    for (let k = 0; k < 9; k++) await page.keyboard.press('Shift+ArrowRight');
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.evaluate(() => document.querySelector<HTMLElement>('.md-editor')!.parentElement!.scrollTo?.(0, 0));
    expect(await run(page, { kind: 'jump', to: 'selection' })).toBe(true);
    const visible = await page.evaluate(() => {
      const r = getSelection()!.getRangeAt(0).getBoundingClientRect();
      return r.top >= 0 && r.bottom <= innerHeight;
    });
    expect(visible).toBe(true);
    await page.keyboard.type('Z');
    expect(await md(page)).toContain('\n\nZ 40 text.\n\n');
  });

  test('menu.edit.find-options: Find options: whole word and regular expression', async ({ page }) => {
    await boot(page);
    const T = 'cat concat Cat cat.\n\nDates 2026-10 and 1999-01.\n';
    await page.evaluate((t) => window.__margin!.editor.setMarkdown(t), T);
    await caretAtText(page, 'cat concat', 0);
    await page.keyboard.press(`${MOD}+f`);
    const bar = page.locator('.findbar');
    const status = bar.locator('.find-status');
    await page.keyboard.type('cat');
    await expect(status).toHaveText(/4 matches|1 of 4/);
    await bar.locator('.find-word').click();
    await expect(bar.locator('.find-word')).toHaveAttribute('aria-pressed', 'true');
    await expect(status).toHaveText(/3 matches|1 of 3/); // "concat" no longer counts
    await bar.locator('.find-case').click();
    await expect(status).toHaveText(/2 matches|1 of 2/);
    await bar.locator('.find-word').click();
    await bar.locator('.find-case').click();
    // regular expression + group replacement
    await bar.locator('.find-regex').click();
    await bar.locator('.find-input').first().fill('(\\d{4})-(\\d\\d)');
    await expect(status).toHaveText(/2 matches|1 of 2/);
    await page.keyboard.press('Enter');
    await expect(status).toHaveText('1 of 2');
    await page.keyboard.press(`${MOD}+Alt+f`);
    await bar.locator('.find-input').nth(1).fill('$2/$1');
    await bar.locator('.find-replace-all').click();
    await expect.poll(() => editorValue(page)).toBe('cat concat Cat cat.\n\nDates 10/2026 and 01/1999.\n');
    // invalid pattern: reported, nothing selected or replaced
    await bar.locator('.find-input').first().fill('(');
    await expect(status).toHaveText('Invalid pattern');
    await bar.locator('.find-replace-all').click();
    expect(await editorValue(page)).toBe('cat concat Cat cat.\n\nDates 10/2026 and 01/1999.\n');
  });

  test('menu.edit: copy-as / selection / delete / jump are reachable from the native menu and command palette', async ({ page }) => {
    await boot(page);
    const menu = (a: string) => page.evaluate((x) => window.__MARGIN_WEB__!.triggerMenu(x as never), a);
    await page.evaluate(() => window.__margin!.editor.setMarkdown('alpha beta gamma\n\nsecond\n'));
    await caretAtText(page, 'beta', 1);
    await menu('delete:word');
    await expect.poll(() => editorValue(page)).toBe('alpha gamma\n\nsecond\n');
    await menu('select:block');
    await page.keyboard.type('Z');
    await expect.poll(() => editorValue(page)).toBe('Z\n\nsecond\n');
    await menu('jump:bottom');
    await page.keyboard.type('!');
    await expect.poll(() => editorValue(page)).toBe('Z\n\nsecond!\n');
    // keyboard: ⌘D selects the word, ⇧⌘D deletes one
    await caretAtText(page, 'second', 2);
    await page.keyboard.press(`${MOD}+d`);
    await page.keyboard.type('third');
    await expect.poll(() => editorValue(page)).toBe('Z\n\nthird!\n');
    // command palette lists the Edit commands
    await page.keyboard.press(`${MOD}+Shift+a`);
    for (const label of ['Copy as Markdown', 'Paste as Plain Text', 'Select Styled Scope', 'Delete Range', 'Jump to Selection']) {
      await page.locator('.palette-input').fill(label);
      await expect(page.locator('.palette-list li').first()).toContainText(label);
    }
  });
});

