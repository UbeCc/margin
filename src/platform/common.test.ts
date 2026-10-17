import { describe, expect, it } from 'vitest';
import { expandImageDir, generatedImageName, normalizePath, normalizeSettings, relativePath, toMarkdownSrc, DEFAULT_SETTINGS } from './common';
import { fuzzyScore, rankPaths } from './fuzzy';
import { SHORTCUTS, matchShortcut, shortcutLabel } from './shortcuts';

describe('paths', () => {
  it('normalizes and relativizes', () => {
    expect(normalizePath('/a/./b/../c/')).toBe('/a/c');
    expect(relativePath('/a/b', '/a/b/c/d.png')).toBe('c/d.png');
    expect(relativePath('/a/b', '/a/x/d.png')).toBe('../x/d.png');
  });
  it('encodes markdown srcs like the Rust side', () => {
    expect(toMarkdownSrc('My Doc.assets/a (1).png')).toBe('My%20Doc.assets/a%20%281%29.png');
    expect(toMarkdownSrc('图片/x.png')).toBe('图片/x.png');
  });
  it('expands ${filename}', () => {
    expect(expandImageDir('./${filename}.assets', '/n/My Doc.md')).toBe('./My Doc.assets');
    expect(expandImageDir('${filename}', null)).toBe('untitled');
  });
  it('generates image names', () => {
    expect(generatedImageName('png', new Date(2026, 0, 2, 3, 4, 5))).toMatch(/^image-20260102-030405-[a-z0-9]{3}\.png$/);
  });
});

describe('settings normalization', () => {
  it('fills defaults and drops bad values', () => {
    expect(normalizeSettings(null)).toEqual(DEFAULT_SETTINGS);
    const s = normalizeSettings({ theme: 3, imageRule: { kind: 'relative' }, recentFiles: Array(30).fill('/x'), settingsVersion: 2 });
    expect(s.theme).toBe('paper');
    expect(s.imageRule).toEqual(DEFAULT_SETTINGS.imageRule);
    expect(s.recentFiles.length).toBe(20);
    expect('settingsVersion' in s).toBe(false);
  });
});

describe('fuzzy (mirrors quick_open.rs tests)', () => {
  it('requires a subsequence', () => {
    expect(fuzzyScore('rdm', 'README.md')).not.toBeNull();
    expect(fuzzyScore('xyz', 'README.md')).toBeNull();
  });
  it('prefers contiguous / filename / camel matches', () => {
    expect(fuzzyScore('note', 'docs/notes.md')!).toBeGreaterThan(fuzzyScore('note', 'n/o/t/e.md')!);
    expect(fuzzyScore('api', 'guide/api.md')!).toBeGreaterThan(fuzzyScore('api', 'api/guide.md')!);
    expect(fuzzyScore('gs', 'GettingStarted.md')!).toBeGreaterThan(fuzzyScore('gs', 'progress.md')!);
  });
  it('ranks markdown first', () => {
    const r = rankPaths(['src/todo.rs', 'todo.md', 'deep/a/todo.txt', 'img/todo.png'], 'todo');
    expect(r.slice(0, 2)).toEqual(['todo.md', 'deep/a/todo.txt']);
  });
});

describe('shortcuts', () => {
  it('has no duplicate bindings', () => {
    const keys = SHORTCUTS.map((s) => `${s.mod !== false}-${!!s.shift}-${!!s.alt}-${s.code}`);
    expect(new Set(keys).size).toBe(keys.length);
  });
  it('matches and labels', () => {
    expect(matchShortcut({ code: 'Backslash', metaKey: true, ctrlKey: false, shiftKey: false, altKey: false })).toBe('toggleSidebar');
    expect(matchShortcut({ code: 'KeyB', metaKey: false, ctrlKey: false, shiftKey: false, altKey: false })).toBeNull();
    expect(shortcutLabel('saveAs', true)).toBe('⇧⌘S');
    expect(shortcutLabel('saveAs', false)).toBe('Ctrl+Shift+S');
    expect(shortcutLabel('toggleFocus', false)).toBe('F8');
  });
});

describe('printHtmlInIframe', () => {
  it('always settles and removes its frame (no print support, no load)', async () => {
    const { printHtmlInIframe } = await import('./common');
    await printHtmlInIframe('<p>x</p>', 50);
    await new Promise((r) => setTimeout(r, 1100));
    expect(document.querySelectorAll('iframe').length).toBe(0);
  });
});
