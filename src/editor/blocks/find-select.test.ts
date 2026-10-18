import { describe, expect, it } from 'vitest';
import { parseFence, parseFrontMatter, parseHtmlBlock, parseMathBlock, rawRangeToBody, rawToBody } from './util/delimited';
import { cellSpans, locateCell, parseTable } from './table-model';

/** Raw range of the n-th occurrence of `q`. */
function at(raw: string, q: string, n = 0): [number, number] {
  let i = -1;
  for (let k = 0; k <= n; k++) i = raw.indexOf(q, i + 1);
  if (i < 0) throw new Error('not found: ' + q);
  return [i, i + q.length];
}

describe('rawToBody (find in delimited widgets, #35)', () => {
  it('maps fence body offsets and rejects the delimiters', () => {
    const raw = '```js\nconst a = 1;\nfoo();\n```\n\n';
    const p = parseFence(raw);
    const [f, t] = at(raw, 'foo');
    const r = rawRangeToBody(p, f, t)!;
    expect(p.body.slice(r.from, r.to)).toBe('foo');
    expect(rawRangeToBody(p, ...at(raw, 'js'))).toBeNull();
    expect(rawRangeToBody(p, ...at(raw, '```', 1))).toBeNull();
    expect(rawToBody(p, raw.length)).toBeNull();
  });

  it('accounts for the fence indent stripped from each line', () => {
    const raw = '  ~~~~py\n  x = 1\n    y = x\n\n  ~~~~\n';
    const p = parseFence(raw);
    expect(p.body).toBe('x = 1\n  y = x\n');
    for (const q of ['x = 1', 'y = x', '1\n    y']) {
      const r = rawRangeToBody(p, ...at(raw, q))!;
      expect(p.body.slice(r.from, r.to)).toBe(q.replace('\n    ', '\n  '));
    }
    // inside the stripped indent → clamps to the line start
    expect(rawToBody(p, raw.indexOf('x = 1') - 1)).toBe(0);
  });

  it('handles unclosed fences and multi-line ranges', () => {
    const raw = '```\na\nbc\n';
    const p = parseFence(raw);
    const r = rawRangeToBody(p, ...at(raw, 'a\nb'))!;
    expect(p.body.slice(r.from, r.to)).toBe('a\nb');
  });

  it('maps math (block and single-line), front matter and html', () => {
    const m = '$$\nE = mc^2\n$$\n';
    const pm = parseMathBlock(m);
    let r = rawRangeToBody(pm, ...at(m, 'mc'))!;
    expect(pm.body.slice(r.from, r.to)).toBe('mc');
    const m1 = '$$ a+b $$\n';
    const p1 = parseMathBlock(m1);
    r = rawRangeToBody(p1, ...at(m1, 'a+b'))!;
    expect(p1.body.slice(r.from, r.to)).toBe('a+b');
    const fm = '---\ntitle: Hi\n---\n';
    const pf = parseFrontMatter(fm);
    r = rawRangeToBody(pf, ...at(fm, 'Hi'))!;
    expect(pf.body.slice(r.from, r.to)).toBe('Hi');
    expect(rawRangeToBody(pf, ...at(fm, '---', 1))).toBeNull();
    const html = '<div>\n<b>x</b>\n</div>\n\n';
    const ph = parseHtmlBlock(html);
    r = rawRangeToBody(ph, ...at(html, '<b>'))!;
    expect(ph.body.slice(r.from, r.to)).toBe('<b>');
  });
});

describe('locateCell (find in tables, #35)', () => {
  const raw = '| Name | Note |\n| --- | :-: |\n|  alpha | a \\| b |\n| beta |  |\n\n';
  const t = parseTable(raw);

  it('splits cell spans like splitRow', () => {
    const line = '|  alpha | a \\| b |';
    const spans = cellSpans(line);
    expect(spans.map((s) => line.slice(s.start, s.end))).toEqual(['alpha', 'a \\| b']);
    expect(cellSpans('a | b').map((s) => s.end - s.start)).toEqual([1, 1]);
  });

  it('maps a match inside one cell to row/col/offsets', () => {
    expect(locateCell(t, ...at(raw, 'Note'))).toEqual({ r: 0, c: 1, from: 0, to: 4 });
    expect(locateCell(t, ...at(raw, 'lph'))).toEqual({ r: 1, c: 0, from: 1, to: 4 });
    const hit = locateCell(t, ...at(raw, '\\| b'))!;
    expect(t.rows[hit.r][hit.c].slice(hit.from, hit.to)).toBe('\\| b');
    expect(locateCell(t, ...at(raw, 'beta'))).toMatchObject({ r: 2, c: 0 });
  });

  it('rejects ranges over pipes, padding, rows or the delimiter row', () => {
    expect(locateCell(t, ...at(raw, 'Name |'))).toBeNull();
    expect(locateCell(t, ...at(raw, ' alpha'))).toBeNull();
    expect(locateCell(t, ...at(raw, '---'))).toBeNull();
    expect(locateCell(t, ...at(raw, '|\n|'))).toBeNull();
  });

  it('works without a delimiter row', () => {
    const r2 = 'a | b\nc | d\n';
    const t2 = parseTable(r2);
    expect(locateCell(t2, ...at(r2, 'd'))).toEqual({ r: 1, c: 1, from: 0, to: 1 });
  });
});
