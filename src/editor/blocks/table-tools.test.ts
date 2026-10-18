import { describe, expect, it } from 'vitest';
import { parseTable, prettifyTable, resizeTable, serializeTable } from './table-model';
import { tableMarkdown } from '../core/block-tools';

describe('table tools (#98)', () => {
  it('Insert Table builds rows (incl. header) × cols and clamps bad sizes', () => {
    expect(tableMarkdown(3, 2)).toBe('|   |   |\n| --- | --- |\n|   |   |\n|   |   |');
    expect(tableMarkdown(1, 1)).toBe('|   |\n| --- |');
    expect(tableMarkdown(0, -4)).toBe('|   |\n| --- |');
    const t = parseTable(tableMarkdown(4, 5) + '\n');
    expect(t.rows.length).toBe(4);
    expect(t.align.length).toBe(5);
  });

  it('Resize Table grows with empty cells and shrinks from the end', () => {
    const t = parseTable('| a | b |\n|:--|--:|\n| 1 | 2 |\n| 3 | 4 |\n');
    const g = resizeTable(t, 4, 3);
    expect(g.rows).toEqual([['a', 'b', ''], ['1', '2', ''], ['3', '4', ''], ['', '', '']]);
    expect(g.align).toEqual(['left', 'right', null]);
    const s = resizeTable(t, 2, 1);
    expect(s.rows).toEqual([['a'], ['1']]);
    expect(serializeTable(t, s)).toBe('| a   |\n| :-- |\n| 1   |\n');
    expect(resizeTable(t, 0, 0).rows).toEqual([['a']]);
  });

  it('adding rows only keeps the untouched source lines (minimal diff)', () => {
    const raw = '|a|b|\n|-|-|\n|1|2|\n';
    const t = parseTable(raw);
    expect(serializeTable(t, resizeTable(t, 3, 2))).toBe('|a|b|\n|-|-|\n|1|2|\n|||\n');
  });

  it('Prettify Source Code aligns columns and keeps indent + trailing blank lines', () => {
    const t = parseTable('|a|bbb|\n|:-:|-|\n|cc|d|\n\n');
    expect(prettifyTable(t, t)).toBe('|  a  | bbb |\n| :-: | --- |\n| cc  | d   |\n\n');
  });
});
