import { describe, expect, it } from 'vitest';
import { fuzzyScore, rankPaths } from './fuzzy';

// Mirrors src-tauri/src/quick_open_tests.rs so web and desktop rank alike.
describe('fuzzy ranking (unicode)', () => {
  it('matches NFD names with NFC queries and vice versa', () => {
    const nfd = 'Café notes.md';
    expect(rankPaths([nfd, 'other.md'], 'café')).toEqual([nfd]);
    expect(rankPaths(['Café notes.md'], 'café')).toEqual(['Café notes.md']);
  });

  it('folds length-changing lowercase the same way for query and text', () => {
    expect(rankPaths(['İstanbul.md', 'ıx.md'], 'İstanbul')).toEqual(['İstanbul.md']);
    expect(rankPaths(['İstanbul.md'], 'istanbul')).toEqual(['İstanbul.md']);
    expect(fuzzyScore('ß', 'Straße.md')).not.toBeNull();
  });

  it('handles CJK, emoji and whitespace-only queries', () => {
    const files = ['笔记/会议记录.md', 'notes/😀 smile.md', 'a b c.md'];
    expect(rankPaths(files, '会议')[0]).toBe('笔记/会议记录.md');
    expect(rankPaths(files, '😀')[0]).toBe('notes/😀 smile.md');
    expect(rankPaths(files, '   ')).toHaveLength(3);
  });

  it('is independent of input order', () => {
    const files = Array.from({ length: 300 }, (_, i) => `d${i % 7}/note${i}.md`);
    expect(rankPaths([...files].reverse(), 'note1', 20)).toEqual(rankPaths(files, 'note1', 20));
    expect(rankPaths(files, 'note1', 20)[0]).toBe('d1/note1.md');
  });
});
