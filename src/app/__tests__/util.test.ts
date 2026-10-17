import { describe, expect, it } from 'vitest';
import { fuzzyFilter, fuzzyMatch, highlightSegments } from '../util/fuzzy';
import {
  basename, dirname, displayPath, extname, isInside, isValidFileName, join, normalize, relative, resolveDocPath, stripExt, uniqueName,
} from '../util/path';
import { formatShortcut, matchShortcut, parseShortcut } from '../util/keymap';
import { commandForKey, COMMANDS, isCommandId } from '../commands';

describe('fuzzy', () => {
  it('matches subsequences and rejects non-matches', () => {
    expect(fuzzyMatch('rdmp', 'Ideas/Roadmap.md')).not.toBeNull();
    expect(fuzzyMatch('xyz', 'Ideas/Roadmap.md')).toBeNull();
    expect(fuzzyMatch('', 'anything')).toEqual({ score: 0, indices: [] });
  });
  it('returns ascending indices of matched chars', () => {
    const m = fuzzyMatch('road', 'Ideas/Roadmap.md')!;
    expect(m.indices).toEqual([6, 7, 8, 9]);
  });
  it('prefers contiguous, boundary and basename hits', () => {
    const items = ['docs/road-trip/notes.md', 'Ideas/Roadmap.md', 'random/old/abc/data.md'];
    const ranked = fuzzyFilter('road', items, (x) => x).map((r) => r.item);
    expect(ranked[0]).toBe('Ideas/Roadmap.md');
    expect(ranked).toHaveLength(3);
  });
  it('is case-insensitive and ignores spaces in query', () => {
    expect(fuzzyMatch('RE adme', 'README.md')).not.toBeNull();
  });
  it('highlight segments group consecutive hits', () => {
    expect(highlightSegments('abcd', [1, 2])).toEqual([
      { text: 'a', hit: false },
      { text: 'bc', hit: true },
      { text: 'd', hit: false },
    ]);
  });
});

describe('path helpers', () => {
  it('basename/dirname/extname', () => {
    expect(basename('/a/b/c.md')).toBe('c.md');
    expect(basename('/a/b/')).toBe('b');
    expect(dirname('/a/b/c.md')).toBe('/a/b');
    expect(dirname('/a')).toBe('/');
    expect(dirname('C:\\x\\y.md')).toBe('C:\\x');
    expect(dirname('C:\\y.md')).toBe('C:\\');
    expect(extname('a/b.test.md')).toBe('.md');
    expect(extname('.gitignore')).toBe('');
    expect(stripExt('note.md')).toBe('note');
  });
  it('normalize and join', () => {
    expect(normalize('/a/./b/../c')).toBe('/a/c');
    expect(join('/a/b', '../c', 'd.png')).toBe('/a/c/d.png');
    expect(join('/a', '/abs')).toBe('/abs');
    expect(join('C:\\docs', 'img\\x.png')).toBe('C:\\docs\\img\\x.png');
  });
  it('relative and isInside', () => {
    expect(relative('/a/b', '/a/b/c/d.md')).toBe('c/d.md');
    expect(relative('/a/b', '/a/x.md')).toBe('../x.md');
    expect(isInside('/a/b', '/a/b/c')).toBe(true);
    expect(isInside('/a/b', '/a/bc')).toBe(false);
  });
  it('resolveDocPath handles urls, relative, absolute, encoded', () => {
    expect(resolveDocPath('https://x.com/a.png', '/d')).toBeNull();
    expect(resolveDocPath('data:image/png;base64,AA', '/d')).toBeNull();
    expect(resolveDocPath('./assets/my%20pic.png', '/docs')).toBe('/docs/assets/my pic.png');
    expect(resolveDocPath('<assets/a b.png>', '/docs')).toBe('/docs/assets/a b.png');
    expect(resolveDocPath('/abs/x.png', null)).toBe('/abs/x.png');
    expect(resolveDocPath('rel.png', null)).toBeNull();
    expect(resolveDocPath('C:\\img\\x.png', null)).toBe('C:\\img\\x.png');
  });
  it('uniqueName, displayPath, isValidFileName', () => {
    expect(uniqueName('Untitled', '.md', new Set(['untitled.md', 'untitled 2.md']))).toBe('Untitled 3.md');
    expect(displayPath('/Users/me/Notes/a.md')).toBe('~/Notes/a.md');
    expect(displayPath('/r/x/a.md', '/r')).toBe('x/a.md');
    expect(isValidFileName('My note.md')).toBe(true);
    expect(isValidFileName('a/b')).toBe(false);
    expect(isValidFileName('  ')).toBe(false);
  });
});

describe('keymap & commands', () => {
  const ev = (code: string, mods: Partial<{ meta: boolean; ctrl: boolean; shift: boolean; alt: boolean }> = {}) => ({
    code,
    metaKey: !!mods.meta,
    ctrlKey: !!mods.ctrl,
    shiftKey: !!mods.shift,
    altKey: !!mods.alt,
  });
  it('parses and matches with Mod = Cmd on mac, Ctrl elsewhere', () => {
    expect(parseShortcut('Mod+Shift+P')).toMatchObject({ mod: true, shift: true, code: 'KeyP' });
    expect(matchShortcut(ev('KeyP', { meta: true }), 'Mod+P', true)).toBe(true);
    expect(matchShortcut(ev('KeyP', { ctrl: true }), 'Mod+P', true)).toBe(false);
    expect(matchShortcut(ev('KeyP', { ctrl: true }), 'Mod+P', false)).toBe(true);
    expect(matchShortcut(ev('Backslash', { meta: true }), 'Mod+\\', true)).toBe(true);
    expect(matchShortcut(ev('Numpad1', { meta: true }), 'Mod+1', true)).toBe(true);
  });
  it('formats shortcuts per platform', () => {
    expect(formatShortcut('Mod+Shift+P', true)).toBe('⇧⌘P');
    expect(formatShortcut('Mod+Shift+P', false)).toBe('Ctrl+Shift+P');
    expect(formatShortcut('F8', true)).toBe('F8');
  });
  it('maps Typora-style keys to commands', () => {
    expect(commandForKey(ev('Digit2', { meta: true }), true)?.id).toBe('heading:2');
    expect(commandForKey(ev('Digit0', { meta: true }), true)?.id).toBe('heading:0');
    expect(commandForKey(ev('KeyB', { meta: true }), true)?.id).toBe('mark:strong');
    expect(commandForKey(ev('Slash', { meta: true }), true)?.id).toBe('toggleSource');
    expect(commandForKey(ev('F8'), true)?.id).toBe('toggleFocus');
    expect(commandForKey(ev('KeyP', { meta: true, shift: true }), true)?.id).toBe('commandPalette');
    expect(commandForKey(ev('KeyF', { meta: true, alt: true }), true)?.id).toBe('replace');
  });
  it('has no duplicate shortcuts', () => {
    const seen = new Map<string, string>();
    for (const c of COMMANDS)
      for (const k of c.keys ?? []) {
        const p = JSON.stringify(parseShortcut(k));
        expect(seen.get(p), `${k} used by ${seen.get(p)} and ${c.id}`).toBeUndefined();
        seen.set(p, c.id);
      }
  });
  it('validates ids from native menus', () => {
    expect(isCommandId('save')).toBe(true);
    expect(isCommandId('theme:whatever')).toBe(true);
    expect(isCommandId('rm -rf')).toBe(false);
  });
});
