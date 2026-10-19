/**
 * Parity epic #103 — window chrome & writing aids. One test per surface; titles
 * carry the surface id for the parity ledger binding. Native-menu surfaces are
 * driven the way the menu delivers them (`App.run(menuAction)`); the native
 * side (menu check marks, always-on-top, devtools, magnification) is exercised
 * through mocked PlatformExtras patched onto the live platform object.
 */
import { expect, test, type Page } from '@playwright/test';
import { boot, caretAtText, editorValue, ROOT } from './app-helpers';

test.beforeEach(async ({ page }) => boot(page));

const menu = (page: Page, id: string): Promise<boolean> =>
  page.evaluate((a) => window.__margin!.run(a as Parameters<NonNullable<typeof window.__margin>['run']>[0]), id);
const setting = (page: Page, key: string) => page.evaluate((k) => (window.__margin as unknown as { settings: Record<string, unknown> }).settings[k], key);
const setDoc = (page: Page, md: string) => page.evaluate((m) => window.__margin!.editor.setMarkdown(m), md);

/** Patch a PlatformExtras method onto the platform (extras() is a cast, so the App picks it up). */
async function mockExtra(page: Page, name: string, body: string): Promise<void> {
  await page.evaluate(
    ({ name, body }) => {
      const w = window as unknown as Record<string, unknown>;
      w.__extraLog ??= [];
      (w.__MARGIN_WEB__ as unknown as Record<string, unknown>)[name] = new Function(`return ${body}`)()(w.__extraLog);
    },
    { name, body },
  );
}
const extraLog = (page: Page): Promise<unknown[]> => page.evaluate(() => (window as unknown as { __extraLog: unknown[] }).__extraLog);

async function selectText(page: Page, text: string): Promise<void> {
  await page.evaluate((t) => {
    const root = document.querySelector('.md-editor') as HTMLElement;
    const w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    for (let n = w.nextNode(); n; n = w.nextNode()) {
      const i = n.textContent!.indexOf(t);
      if (i < 0) continue;
      root.focus();
      getSelection()!.setBaseAndExtent(n, i, n, i + t.length);
      document.dispatchEvent(new Event('selectionchange'));
      return;
    }
    throw new Error(`text not found: ${t}`);
  }, text);
}

test('menu.view.status-bar: View › Show Status Bar (word count, toggle)', async ({ page }) => {
  const bar = page.locator('footer.statusbar');
  await expect(bar).toBeVisible();
  // Welcome doc: word count of the whole document, plural unit.
  await expect(bar.locator('.word-count')).toContainText(/Words/);
  // Selection: "sel / total Words" (fe-sidebar-statusbar-find §8).
  await selectText(page, 'Welcome to Margin');
  await expect(bar.locator('.word-count')).toContainText(/\d+ \/ \d+ Words/);
  // Popover: four totals + "In Selection" header + selection counts.
  await bar.locator('.word-count').click();
  const items = page.locator('.context-menu .context-item');
  await expect(items.filter({ hasText: 'In Selection' })).toBeVisible();
  await expect(items.filter({ hasText: /Minute/ })).toBeVisible();
  await expect(items.filter({ hasText: /Lines?/ })).toBeVisible();
  await expect(items.filter({ hasText: /Characters?/ }).first()).toBeVisible();
  // Typora's fixed order: Minutes, Lines, Words, Characters (native-window-touchbar §3.9).
  const totals = (await items.allTextContents()).slice(0, 4).map((t) => (/(Minute|Line|Word|Character)/.exec(t) ?? [''])[0]);
  expect(totals).toEqual(['Minute', 'Line', 'Word', 'Character']);
  await items.filter({ hasText: /Characters?/ }).first().click();
  await expect(bar.locator('.word-count')).toContainText(/Characters?/);
  expect(await setting(page, 'wordCountUnit')).toBe('characters');
  // View › Show Status Bar hides the bar; the floating count appears only with
  // "Always Show Word Count".
  await menu(page, 'toggleStatusBar');
  await expect(bar).toBeHidden();
  await page.evaluate(() => (window.__margin as unknown as { updateSettings(p: object): void }).updateSettings({ alwaysShowWordCount: true }));
  const floating = page.locator('.word-count-floating');
  await expect(floating).toBeVisible();
  await expect(floating).toContainText(/Characters?/);
  await menu(page, 'toggleStatusBar');
  await expect(bar).toBeVisible();
  await expect(floating).toBeHidden();
});

test('menu.edit.spelling: Edit › Spelling: check while typing, check now, learn/unlearn, grammar, autocorrect', async ({ page }) => {
  const ed = page.locator('.md-editor');
  await expect(ed).toHaveAttribute('spellcheck', 'false'); // off by default
  await menu(page, 'spell:toggle');
  await expect(ed).toHaveAttribute('spellcheck', 'true');
  expect(await setting(page, 'spellcheck')).toBe(true);
  // Grammar and autocorrect toggles persist; autocorrect drives the WebKit
  // typing-aid attributes on the editable region.
  await menu(page, 'spell:grammar');
  expect(await setting(page, 'spellGrammar')).toBe(true);
  await menu(page, 'spell:autocorrect');
  expect(await setting(page, 'spellAutocorrect')).toBe(true);
  await expect(ed).toHaveAttribute('autocorrect', 'on');
  await expect(ed).toHaveAttribute('autocapitalize', 'sentences');
  // Check Document Now re-runs the pass without touching the source.
  const before = await editorValue(page);
  await menu(page, 'spell:now');
  expect(await editorValue(page)).toBe(before);
  // Negative: turning everything off restores the attributes.
  await menu(page, 'spell:autocorrect');
  await menu(page, 'spell:toggle');
  await expect(ed).toHaveAttribute('spellcheck', 'false');
  await expect(ed).toHaveAttribute('autocorrect', 'off');
});

test('menu.edit.substitutions: Edit › Substitutions: smart quotes/dashes/punctuation, text replacement', async ({ page }) => {
  await setDoc(page, 'Smart aids here\n');
  // Convert on Input (default): " opens after a space, closes after a letter.
  await menu(page, 'subst:quotes');
  await caretAtText(page, 'Smart aids', 10);
  await page.keyboard.type(' "he');
  await expect.poll(() => editorValue(page)).toContain('“he');
  await page.keyboard.type('"');
  await expect.poll(() => editorValue(page)).toContain('“he”');
  // Smart dashes: word- + - → –, a further - → —.
  await menu(page, 'subst:dashes');
  await page.keyboard.type(' word---');
  await expect.poll(() => editorValue(page)).toContain('word—');
  // Input mode with quotes or dashes on locks the parse remap on (§5.4).
  const md = await setting(page, 'markdown');
  expect(md).toMatchObject({ smartPunctuation: 'input', smartQuote: true, smartDash: true, remapPunctuation: true });
  // Text Replacement is a stored toggle forwarded to the web view.
  await menu(page, 'subst:textReplacement');
  expect(await setting(page, 'smartTextReplacement')).toBe(true);
  // Negative: Convert on Rendering keeps the source ASCII while typing.
  await setDoc(page, 'Render mode\n');
  await menu(page, 'subst:render');
  await caretAtText(page, 'Render mode', 11);
  await page.keyboard.type(' "x');
  await expect.poll(() => editorValue(page)).toContain('"x');
  expect((await setting(page, 'markdown'))).toMatchObject({ smartPunctuation: 'rendering' });
  // Straight quotes are kept inside code fences (raw context).
  await setDoc(page, '```js\nxy\n```\n');
  await menu(page, 'subst:input');
  await caretAtText(page, 'xy', 2);
  await page.keyboard.type("'");
  await expect.poll(() => editorValue(page)).toContain("xy'");
});

test('menu.edit.speech: Edit › Speech: Start / Stop Speaking', async ({ page }) => {
  await page.evaluate(() => {
    const calls: string[] = [];
    Object.defineProperty(window, 'speechSynthesis', { configurable: true, value: {
      cancel: () => calls.push('cancel'),
      speak: (u: SpeechSynthesisUtterance) => calls.push(`speak:${u.text}`),
      speaking: false,
      pending: false,
      paused: false,
  } });
    (window as unknown as { __speech: string[] }).__speech = calls;
  });
  const calls = () => page.evaluate(() => (window as unknown as { __speech: string[] }).__speech);
  // No selection → the whole document is read.
  await menu(page, 'speech:start');
  await expect.poll(() => calls()).toContainEqual(expect.stringContaining('Welcome to Margin'));
  // A second Start replaces the first (no queueing).
  await selectText(page, 'Welcome to Margin');
  await menu(page, 'speech:start');
  await expect.poll(() => calls()).toContainEqual('speak:Welcome to Margin');
  // Stop cancels immediately.
  await menu(page, 'speech:stop');
  await expect.poll(() => calls()).toContainEqual('cancel');
});

test('menu.edit.emoji: Edit › Emoji and Symbols (system picker) and :emoji: autocomplete', async ({ page }) => {
  await setDoc(page, 'Emoji play\n');
  // :shortcode: autocomplete: `:` + letters opens the popup, Enter accepts.
  await caretAtText(page, 'Emoji play', 10);
  await page.keyboard.type(' :smile');
  const popup = page.locator('.emoji-popup');
  await expect(popup).toBeVisible();
  await expect(popup.locator('.emoji-item').first()).toContainText(':smile:');
  await page.keyboard.press('Enter');
  await expect.poll(() => editorValue(page)).toContain('Emoji play :smile:');
  // Edit › Emoji and Symbols opens the full picker at the caret; accepting
  // replaces the inserted trigger colon with the chosen `:name:`.
  await page.keyboard.press('End');
  await menu(page, 'emojiPicker');
  await expect(popup).toBeVisible();
  await expect(popup.locator('.emoji-item')).not.toHaveCount(0);
  await popup.locator('.emoji-item').first().click();
  const v = await editorValue(page);
  expect(v).not.toContain('\n:');
  expect((v.match(/:[a-z0-9_+-]+:/g) ?? []).length).toBeGreaterThanOrEqual(2);
});

test('menu.view.always-on-top: View › Always on Top', async ({ page }) => {
  // Per-window float, never persisted (native-commands §5.1) — mocked native side.
  await mockExtra(page, 'setAlwaysOnTop', `(log) => async (on) => { log.push(['setAlwaysOnTop', on]); return on; }`);
  expect(await setting(page, 'alwaysOnTop')).toBeUndefined();
  await menu(page, 'alwaysOnTop');
  await expect.poll(() => extraLog(page)).toContainEqual(['setAlwaysOnTop', true]);
  await menu(page, 'alwaysOnTop');
  await expect.poll(() => extraLog(page)).toContainEqual(['setAlwaysOnTop', false]);
  // Still not persisted after two toggles.
  expect(await setting(page, 'alwaysOnTop')).toBeUndefined();
});

test('menu.view.devtools: View › Toggle DevTools / Inspect Element (debug builds)', async ({ page }) => {
  await mockExtra(page, 'toggleDevtools', `(log) => async () => { log.push(['toggleDevtools']); }`);
  await menu(page, 'toggleDevtools');
  await expect.poll(() => extraLog(page)).toContainEqual(['toggleDevtools']);
});

test('menu.view.magnification: View › Allow Magnification (trackpad pinch zoom)', async ({ page }) => {
  // Global switch, stored inverted by Typora (`noMagnification`); on by default.
  expect(await setting(page, 'allowMagnification')).toBe(true);
  await mockExtra(page, 'setMagnification', `(log) => async (allow) => { log.push(['setMagnification', allow]); }`);
  await menu(page, 'toggleMagnification');
  await expect.poll(() => extraLog(page)).toContainEqual(['setMagnification', false]);
  expect(await setting(page, 'allowMagnification')).toBe(false);
  await menu(page, 'toggleMagnification');
  await expect.poll(() => extraLog(page)).toContainEqual(['setMagnification', true]);
  expect(await setting(page, 'allowMagnification')).toBe(true);
});

test('menu.state-sync: Native menu state sync (enabled/checked items follow editor state)', async ({ page }) => {
  await mockExtra(page, 'setMenuChecked', `(log) => async (id, checked) => { log.push([id, checked]); }`);
  await mockExtra(page, 'setMenuEnabled', `(log) => async (id, enabled) => { log.push(['enabled', id, enabled]); }`);
  // Any settings change pushes the full check state to the native menu.
  await menu(page, 'spell:toggle');
  await expect.poll(() => extraLog(page)).toContainEqual(['spell:toggle', true]);
  // §5.4: enabling smart quotes in input mode ticks AND disables the remap item.
  await page.evaluate(() => (window.__extraLog as unknown[]).splice(0));
  await menu(page, 'subst:quotes');
  await expect.poll(() => extraLog(page)).toContainEqual(['subst:quotes', true]);
  await expect.poll(() => extraLog(page)).toContainEqual(['subst:remap', true]);
  await expect.poll(() => extraLog(page)).toContainEqual(['enabled', 'subst:remap', false]);
  // The mode radio pair stays exclusive.
  await expect.poll(() => extraLog(page)).toContainEqual(['subst:input', true]);
  await expect.poll(() => extraLog(page)).toContainEqual(['subst:render', false]);
  // View toggles sync too.
  await menu(page, 'toggleStatusBar');
  await expect.poll(() => extraLog(page)).toContainEqual(['toggleStatusBar', false]);
});
