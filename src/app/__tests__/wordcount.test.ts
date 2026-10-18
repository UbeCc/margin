import { describe, expect, it } from 'vitest';
import { countMarkdown, countWords, formatCount, readingMinutes } from '../wordcount';

describe('word count rules (#103)', () => {
  it('CJK characters count one each; Hangul does not', () => {
    expect(countWords('中文排版')).toBe(4);
    expect(countWords('ひらがなカタカナ')).toBe(8);
    expect(countWords('한국어')).toBe(1);
    expect(countWords('Margin 里，中英文混排')).toBe(1 + 6);
  });
  it('splits on whitespace and punctuation except - . / \'', () => {
    expect(countWords("don't a-b 3.14 and/or")).toBe(4);
    expect(countWords('hello, world! (yes)')).toBe(3);
    expect(countWords('— ... !!! **')).toBe(0);
  });
  it('markdown: syntax punctuation dropped, link destinations not counted', () => {
    const md = '# Title\n\nSee [the docs](https://example.com/a-b "t") and `code`.\n';
    expect(countMarkdown(md)).toEqual({ words: 6, characters: md.length, lines: 4 });
    expect(countMarkdown('')).toEqual({ words: 0, characters: 0, lines: 1 });
  });
  it('labels and reading time', () => {
    expect(formatCount(1, 'words')).toBe('1 Word');
    expect(formatCount(1234, 'words')).toBe('1,234 Words');
    expect(formatCount(0, 'minutes')).toBe('≤ 1 Minute');
    expect(formatCount(2, 'lines')).toBe('2 Lines');
    expect(readingMinutes(1000)).toBe(3);
    expect(readingMinutes(100)).toBe(0);
    expect(readingMinutes(300, 120)).toBe(3);
  });
});
