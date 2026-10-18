import { describe, expect, it } from 'vitest';
import type { DirEntry } from '../../contracts';
import { sortEntries, SORT_OPTIONS, isSortOrder, nameCompare } from '../sidebar/sort';
import { summarize, collectDocs } from '../sidebar/walk';
import { findLines } from '../sidebar/search';
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
  it('summary strips front matter and markdown syntax', () => {
    const t = '---\ntitle: x\n---\n# Hello *world*\n\n- [ ] task with [link](http://a)\n> quote `code`\n';
    expect(summarize(t)).toBe('Hello world task with link quote code');
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
  it('finds literal matches per line, case-insensitive by default', () => {
    const r = findLines('Alpha beta\nnothing\n  ALPHA and alpha', 'alpha', false);
    expect(r.total).toBe(3);
    expect(r.hits.map((h) => h.line)).toEqual([1, 3]);
    expect(r.hits[1].text).toBe('ALPHA and alpha');
    expect(r.hits[1].ranges).toEqual([[0, 5], [10, 15]]);
    expect(findLines('Alpha', 'alpha', true).total).toBe(0);
  });
  it('windows long lines around the first match', () => {
    const line = 'x'.repeat(100) + 'needle' + 'y'.repeat(10);
    const [hit] = findLines(line, 'needle', false).hits;
    expect(hit.text.startsWith('…')).toBe(true);
    const [a, b] = hit.ranges[0];
    expect(hit.text.slice(a, b)).toBe('needle');
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
  it('filter keeps matches and their ancestors', () => {
    expect([...filterHeadings(hs, 'inst')].sort()).toEqual([0, 1, 2]);
    expect(filterHeadings(hs, 'zzz').size).toBe(0);
    expect(filterHeadings(hs, ' ').size).toBe(5);
  });
});
