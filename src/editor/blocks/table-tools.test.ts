import { describe, expect, it } from 'vitest';
import { moveRow, parseTable, prettifyTable, resizeTable, serializeTable } from './table-model';
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
    expect(prettifyTable(t, t)).toBe('|  a   | bbb  |\n| :--: | ---- |\n|  cc  | d    |\n\n');
    const wide = parseTable('|' + 'x'.repeat(70) + '|y|\n|-|-|\n|中文|z|\n');
    const out = prettifyTable(wide, wide).split('\n');
    expect(out[1]).toBe('| ' + '-'.repeat(60) + ' | ---- |');
    expect(out[2]).toBe('| 中文' + ' '.repeat(56) + ' | z    |');
  });

  it('moving a body row above the header makes it the header (header mode only)', () => {
    const t = parseTable('|h|\n|-|\n|1|\n|2|\n');
    expect(moveRow(t, 1, 0).rows).toEqual([['h'], ['1'], ['2']]);
    expect(moveRow(t, 1, 0, true).rows).toEqual([['1'], ['h'], ['2']]);
    expect(moveRow(t, 2, 3, true).rows).toEqual(t.rows);
  });
});
