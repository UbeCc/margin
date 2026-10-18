import { describe, expect, it } from 'vitest';
import type { DirEntry } from '../../contracts';
import { sortEntries, SORT_OPTIONS, isSortOrder, nameCompare } from '../sidebar/sort';
import { summarize, collectDocs, dateLabel, isListedDoc } from '../sidebar/walk';
import { findLines, makeMatcher, groupTitle } from '../sidebar/search';
import { copyName } from '../sidebar/filetree';
import { filterHeadings, headingParents } from '../sidebar/outline';
import { WebPlatform } from '../../platform/web';
import { migrateSettings } from '../settings';

const e = (name: string, isDir: boolean, mtime: number, ctime?: number): DirEntry => ({ name, path: `/r/${name}`, isDir, mtime, ctime, size: 0 });
const names = (xs: DirEntry[]) => xs.map((x) => x.name);

describe('sidebar sort', () => {
  const xs = [e('b10.md', false, 3, 1), e('b2.md', false, 1, 3), e('A.md', false, 2, 2), e('dir', true, 9, 9), e('.hidden', false, 0)];
  it('has the eight Typora sort entries', () => {
    expect(SORT_OPTIONS.map((o) => o.label)).toEqual([
      'Sort by Name (Ascending)',
      'Sort by Name (Descending)',
      'Sort Naturally (Ascending)',
      'Sort Naturally (Descending)',
      'Sort by Creation Date (Ascending)',
      'Sort by Creation Date (Descending)',
      'Sort by Modification Date (Ascending)',
      'Sort by Modification Date (Descending)',
    ]);
    expect(isSortOrder('modified-desc')).toBe(true);
    expect(isSortOrder('size-asc')).toBe(false);
  });
  it('name vs natural ordering, folders first, dotfiles hidden', () => {
    expect(names(sortEntries(xs, 'name-asc'))).toEqual(['dir', 'A.md', 'b10.md', 'b2.md']);
    // base name (before the first dot) compares first: "a.md" < "a-b.md"
    expect(names(sortEntries([e('a-b.md', false, 1), e('a.md', false, 1)], 'name-asc'))).toEqual(['a.md', 'a-b.md']);
    // Group By Folder off: folders interleave with files
    expect(names(sortEntries(xs, 'name-asc', false))).toEqual(['A.md', 'b10.md', 'b2.md', 'dir']);
    expect(names(sortEntries(xs, 'natural-asc'))).toEqual(['dir', 'A.md', 'b2.md', 'b10.md']);
    expect(names(sortEntries(xs, 'natural-desc'))).toEqual(['dir', 'b10.md', 'b2.md', 'A.md']);
    expect(nameCompare('a', 'B')).toBeLessThan(0);
  });
  it('dates: modified uses mtime, created uses ctime (falls back to mtime)', () => {
    expect(names(sortEntries(xs, 'modified-asc'))).toEqual(['dir', 'b2.md', 'A.md', 'b10.md']);
    expect(names(sortEntries(xs, 'modified-desc'))).toEqual(['dir', 'b10.md', 'A.md', 'b2.md']);
    expect(names(sortEntries(xs, 'created-asc'))).toEqual(['dir', 'b10.md', 'A.md', 'b2.md']);
    const noBirth = [e('x.md', false, 5), e('y.md', false, 1)];
    expect(names(sortEntries(noBirth, 'created-asc'))).toEqual(['y.md', 'x.md']);
  });
  it('settings: sort/view/outline keys validated with defaults', () => {
    const s = migrateSettings({ sidebarSort: 'bogus', sidebarFileView: 'grid', outlineCollapsible: 'true' });
    expect(s.sidebarSort).toBe('natural-asc');
    expect(s.sidebarFileView).toBe('tree');
    expect(s.outlineCollapsible).toBe(true);
    expect(migrateSettings({ sidebarSort: 'modified-desc', sidebarFileView: 'list' })).toMatchObject({ sidebarSort: 'modified-desc', sidebarFileView: 'list' });
  });
});

describe('articles list', () => {
  it('summary: front matter title/description first, then stripped body lines', () => {
    const t = '---\ntitle: "My Post"\ndescription: about it\nlayout: x\n---\n# Hello *world*\n\n- [ ] task with [link](http://a)\n> quote `code`\n';
    expect(summarize(t)).toBe('My Post\nabout it\nHello world\ntask with link\nquote code');
    expect(summarize('---\ntitle: a\nsubtitle: b\nsummary: c\n---\nbody')).toBe('a\nb\nc');
    expect(summarize('a'.repeat(500), 10)).toBe('aaaaaaaaaa…');
  });
  it('collects documents breadth-first, skips node_modules/dot dirs, caps at the limit', async () => {
    const p = new WebPlatform({ persist: false, seed: false, keyboardShortcuts: false });
    for (const f of ['/w/a.md', '/w/sub/b.md', '/w/node_modules/x.md', '/w/.git/y.md', '/w/pic.png', '/w/c.txt']) await p.writeTextFile(f, 'x');
    const all = await collectDocs(p, '/w');
    expect(all.oversize).toBe(false);
    expect(names(all.docs).sort()).toEqual(['a.md', 'b.md', 'c.txt']);
    const capped = await collectDocs(p, '/w', { limit: 2 });
    expect(capped.docs.length).toBe(2);
    expect(capped.oversize).toBe(true);
  });
});

describe('sidebar search', () => {
  const lit = { caseSensitive: false, wholeWord: false, regex: false };
  it('finds literal matches per line, case-insensitive by default', () => {
    const r = findLines('Alpha beta\nnothing\n  ALPHA and alpha', makeMatcher('alpha', lit)!);
    expect(r.total).toBe(3);
    expect(r.hits.map((h) => h.line)).toEqual([1, 3]);
    expect(r.hits[1].ranges).toEqual([[2, 7], [12, 17]]);
    expect(r.hits[1].before).toBe(1);
    expect(findLines('Alpha', makeMatcher('alpha', { ...lit, caseSensitive: true })!).total).toBe(0);
  });
  it('whole word, regex, invalid regex', () => {
    expect(findLines('cat catalog', makeMatcher('cat', { ...lit, wholeWord: true })!).total).toBe(1);
    expect(findLines('a1 b22', makeMatcher('\\d+', { ...lit, regex: true })!).total).toBe(2);
    expect(makeMatcher('(', { ...lit, regex: true })).toBeNull();
  });
  it('cuts text before the first match to "..." + 20 chars; caps at 21 lines', () => {
    const line = 'x'.repeat(100) + 'needle';
    const [hit] = findLines(line, makeMatcher('needle', lit)!).hits;
    expect(hit.text).toBe('...' + 'x'.repeat(20) + 'needle');
    expect(hit.text.slice(...hit.ranges[0])).toBe('needle');
    expect(findLines('n\n'.repeat(40), makeMatcher('n', lit)!).hits.length).toBe(21);
  });
  it('block title is the parent path joined with " / "', () => {
    expect(groupTitle('/r/Notes', '/r/Notes/a/b/x.md')).toBe('Notes / a / b');
    expect(groupTitle('/r/Notes', '/r/Notes/x.md')).toBe('Notes');
  });
});

describe('sidebar file rules', () => {
  it('lists Typora extensions + extension-less files only', () => {
    expect(['a.md', 'b.MDX', 'c.qmd', 'README', 'd.apib'].every(isListedDoc)).toBe(true);
    expect(['x.png', '.hidden.md', 'y.rs'].some(isListedDoc)).toBe(false);
  });
  it('Keep Both inserts " (copy)" before the first dot', () => {
    expect(copyName('a.b.md')).toBe('a (copy).b.md');
    expect(copyName('README')).toBe('README (copy)');
  });
  it('Articles date labels', () => {
    const now = new Date(2026, 9, 18, 15, 0).getTime();
    expect(dateLabel(now - 10_000, now)).toBe('just now');
    expect(dateLabel(now - 45_000, now)).toBe('1 minutes ago');
    expect(dateLabel(now - 5 * 60_000, now)).toBe('5 minutes ago');
    expect(dateLabel(new Date(2026, 9, 18, 12, 5).getTime(), now)).toBe('12:05');
    expect(dateLabel(new Date(2026, 9, 17, 9, 0).getTime(), now)).toBe('Yesterday');
    expect(dateLabel(new Date(2026, 9, 14, 9, 0).getTime(), now)).toBe('4 days ago');
    expect(dateLabel(new Date(2026, 2, 3).getTime(), now)).toBe('Mar 03');
    expect(dateLabel(new Date(2025, 2, 3).getTime(), now)).toBe('2025-03-03');
  });
});

describe('outline tree', () => {
  const hs: { level: 1 | 2 | 3; text: string }[] = [
    { level: 1, text: 'Intro' },
    { level: 2, text: 'Setup' },
    { level: 3, text: 'Install' },
    { level: 2, text: 'Usage' },
    { level: 1, text: 'Appendix' },
  ];
  it('parents follow heading levels', () => {
    expect(headingParents(hs)).toEqual([-1, 0, 1, 0, -1]);
  });
  it('filter keeps only matching rows (no ancestors)', () => {
    expect([...filterHeadings(hs, 'inst')]).toEqual([2]);
    expect(filterHeadings(hs, 'zzz').size).toBe(0);
    expect(filterHeadings(hs, ' ').size).toBe(5);
  });
});
