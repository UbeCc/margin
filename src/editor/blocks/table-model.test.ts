import { describe, expect, it } from 'vitest';
import {
  cloneModel,
  deleteCol,
  deleteRow,
  emptyTable,
  escapeCell,
  formatTable,
  insertCol,
  insertRow,
  isDelimiterRow,
  moveCol,
  moveRow,
  parseTable,
  serializeTable,
  setAlign,
  splitRow,
  strWidth,
} from './table-model';

describe('splitRow', () => {
  it('splits on unescaped pipes with optional outer pipes', () => {
    expect(splitRow('| a | b |')).toEqual(['a', 'b']);
    expect(splitRow('a | b')).toEqual(['a', 'b']);
    expect(splitRow('|a|b')).toEqual(['a', 'b']);
    expect(splitRow('| a \\| b | `c\\|d` |')).toEqual(['a \\| b', '`c\\|d`']);
    expect(splitRow('| | x |')).toEqual(['', 'x']);
    expect(splitRow('| a \\|')).toEqual(['a \\|']);
  });
  it('delimiter rows', () => {
    expect(isDelimiterRow('| --- | :-: | --: |')).toBe(true);
    expect(isDelimiterRow('---|---')).toBe(true);
    expect(isDelimiterRow('| a | b |')).toBe(false);
    expect(isDelimiterRow('| - - | --- |')).toBe(true);
  });
});

describe('parseTable', () => {
  it('parses header, alignment and body', () => {
    const t = parseTable('| A | B | C |\n|:--|:-:|--:|\n| 1 | 2 | 3 |\n| 4 |\n\n');
    expect(t.align).toEqual(['left', 'center', 'right']);
    expect(t.rows).toEqual([
      ['A', 'B', 'C'],
      ['1', '2', '3'],
      ['4', '', ''],
    ]);
    expect(t.tail).toBe('\n\n');
  });
  it('truncates extra cells and pads short header', () => {
    const t = parseTable('a|b\n-|-\n1|2|3\n');
    expect(t.rows[1]).toEqual(['1', '2']);
  });
});

describe('serializeTable', () => {
  const ORIGINALS = [
    '|a|b|\n|-|-|\n|1|2|\n',
    'a | b\n--- | ---\n1 | 2\n\n\n',
    '| 名前 | Value |\n| :--- | ----: |\n| 太郎 | 1 |',
    '  | x |\n  |---|\n  | y |\n',
  ];
  it.each(ORIGINALS)('preserves original formatting when unchanged %j', (raw) => {
    const t = parseTable(raw);
    expect(serializeTable(t, cloneModel(t))).toBe(raw);
  });

  it('re-formats the whole table on column-level changes', () => {
    const t = parseTable('|a|b|\n|:-:|-:|\n|1|2|\n\n');
    const m = setAlign(cloneModel(t), 0, 'left');
    m.rows[1][0] = 'longer';
    expect(serializeTable(t, m)).toBe(['| a      |   b |', '| :----- | --: |', '| longer |   2 |'].join('\n') + '\n\n');
  });

  it('only rewrites the edited row of a compact table (#6)', () => {
    const t = parseTable('|a|b|\n|:-:|-:|\n|1|2|\n|3|4|\n\n');
    const m = cloneModel(t);
    m.rows[1][0] = 'longer';
    expect(serializeTable(t, m)).toBe('|a|b|\n|:-:|-:|\n|longer|2|\n|3|4|\n\n');
    const s = parseTable('a | b\n--|--\n1 | 2\n');
    const n = cloneModel(s);
    n.rows[1][1] = 'x|y';
    expect(serializeTable(s, n)).toBe('a | b\n--|--\n1 | x\\|y\n');
  });

  it('keeps untouched lines of an aligned table and pads edits to its widths (#6)', () => {
    const src = '| h1  | h2  |\n| --- | --- |\n| a   | b   |\n| c   | d   |\n';
    const t = parseTable(src);
    expect(t.pretty).toBe(true);
    let m = cloneModel(t);
    m.rows[2][1] = 'x';
    expect(serializeTable(t, m)).toBe(src.replace('| c   | d   |', '| c   | x   |'));
    m.rows[2][1] = 'a much longer cell';
    expect(serializeTable(t, m)).toBe(src.replace('| c   | d   |', '| c   | a much longer cell |'));
    m = insertRow(cloneModel(t), 2);
    expect(serializeTable(t, m)).toBe('| h1  | h2  |\n| --- | --- |\n| a   | b   |\n|     |     |\n| c   | d   |\n');
    m = moveRow(deleteRow(cloneModel(t), 1), 1, 1);
    expect(serializeTable(t, m)).toBe('| h1  | h2  |\n| --- | --- |\n| c   | d   |\n');
    m = moveRow(cloneModel(t), 2, 1);
    expect(serializeTable(t, m)).toBe('| h1  | h2  |\n| --- | --- |\n| c   | d   |\n| a   | b   |\n');
  });

  it('uses display width for CJK and keeps indent', () => {
    expect(strWidth('名前')).toBe(4);
    const t = parseTable('  |名前|x|\n  |-|-|\n');
    const m = cloneModel(t);
    m.rows[0][1] = 'y';
    expect(serializeTable(t, m)).toBe('  |名前|y|\n  |-|-|\n');
    expect(formatTable(m, '  ')).toBe('  | 名前 | y   |\n  | ---- | --- |');
    const p = parseTable('| 名前 | x   |\n| ---- | --- |\n| a    | b   |\n');
    const n = cloneModel(p);
    n.rows[1][0] = '漢';
    expect(serializeTable(p, n)).toBe('| 名前 | x   |\n| ---- | --- |\n| 漢   | b   |\n');
  });

  it('escapes pipes and flattens newlines in cells', () => {
    expect(escapeCell('a|b')).toBe('a\\|b');
    expect(escapeCell('a\\|b')).toBe('a\\|b');
    expect(escapeCell('x\ny')).toBe('x y');
    const out = formatTable({ rows: [['h'], ['a|b']], align: [null] });
    expect(parseTable(out).rows[1][0]).toBe('a\\|b');
  });

  it('formatted output re-parses to the same model', () => {
    const m = { rows: [['Name', 'Qty', 'Note'], ['apple', '3', '**fresh**'], ['', '10', '`x`']], align: ['left', 'right', null] as const };
    const model = { rows: m.rows, align: [...m.align] };
    const out = formatTable(model);
    const back = parseTable(out + '\n');
    expect(back.rows).toEqual(model.rows);
    expect(back.align).toEqual(model.align);
  });
});

describe('structural edits', () => {
  const base = () => parseTable('|a|b|\n|-|-|\n|1|2|\n|3|4|\n');
  it('insert/delete rows', () => {
    expect(insertRow(base(), 1).rows).toEqual([['a', 'b'], ['', ''], ['1', '2'], ['3', '4']]);
    expect(insertRow(base(), 0).rows[1]).toEqual(['', '']); // never above header
    expect(deleteRow(base(), 2).rows).toEqual([['a', 'b'], ['1', '2']]);
    expect(deleteRow(base(), 0).rows[0]).toEqual(['1', '2']);
  });
  it('insert/delete cols and align', () => {
    const m = insertCol(base(), 1);
    expect(m.rows[0]).toEqual(['a', '', 'b']);
    expect(m.align).toEqual([null, null, null]);
    expect(deleteCol(m, 0).rows[1]).toEqual(['', '2']);
    expect(deleteCol(deleteCol(deleteCol(m, 0), 0), 0).align.length).toBe(1);
    expect(setAlign(base(), 1, 'center').align).toEqual([null, 'center']);
  });
  it('move rows/cols', () => {
    expect(moveRow(base(), 1, 2).rows.slice(1)).toEqual([['3', '4'], ['1', '2']]);
    expect(moveRow(base(), 1, 0).rows[0]).toEqual(['a', 'b']);
    const mc = moveCol(setAlign(base(), 0, 'left'), 0, 1);
    expect(mc.rows[0]).toEqual(['b', 'a']);
    expect(mc.align).toEqual([null, 'left']);
  });
  it('emptyTable', () => {
    expect(formatTable(emptyTable(2, 2))).toBe('|     |     |\n| --- | --- |\n|     |     |');
  });
});
