import { describe, it, expect } from 'vitest';
import { Doc } from './model';
import { taskState, setTask } from './edit';
import { clearRange, nextFootnoteLabel, footnoteDef, footnoteRef } from './para-cmds';
import { parseInline, inlineSource, inlinePlain } from './parser/inline';
import { blockInlineHTML } from './html';

const ctx = { refs: new Map(), resolveAsset: (s: string) => s, inlineMath: null };

describe('inline <u>/<sub>/<sup> wraps', () => {
  it('parse as wraps and round-trip', () => {
    for (const src of ['a <u>b</u> c', 'H<sub>2</sub>O', 'x<sup>**2**</sup>', '<u>open', '<u><u>n</u></u>', '<U>up</U>', 'a <!-- c --> b']) {
      expect(inlineSource(parseInline(src)), src).toBe(src);
    }
    const n = parseInline('H<sub>2</sub>O');
    expect(n[1]).toMatchObject({ k: 'wrap', tag: 'sub' });
    expect(inlinePlain(parseInline('x<sup>2</sup> <u>u</u>'))).toBe('x2 u');
    // unclosed tag stays raw inline html
    expect(parseInline('<u>open')[0]).toMatchObject({ k: 'html' });
  });
  it('export as real tags', () => {
    expect(blockInlineHTML('<u>a</u> H<sub>2</sub>O x<sup>2</sup>', ctx)).toBe('<u>a</u> H<sub>2</sub>O x<sup>2</sup>');
  });
});

describe('clearRange (Format › Clear Format)', () => {
  const clear = (body: string, f = 0, t = body.length) => {
    const r = clearRange(body, f, t);
    return body.slice(0, r.s) + r.text + body.slice(r.e);
  };
  it('strips every inline style in the range', () => {
    expect(clear('**b** *i* `c` ~~s~~ ==h== <u>u</u> <sub>x</sub> <sup>y</sup>')).toBe('b i c s h u x y');
    expect(clear('a [link **x**](http://e.com) b')).toBe('a link x b');
    expect(clear('***both***')).toBe('both');
  });
  it('touching a wrap clears it whole; untouched wraps stay', () => {
    const body = '**bold** and *em*';
    expect(clear(body, 2, 4)).toBe('bold and *em*');
    expect(clear(body, 9, 10)).toBe('**bold** and *em*');
  });
  it('keeps non-format content (math, images, footnotes, escapes)', () => {
    expect(clear('$x$ ![a](b.png) [^1] \\*n\\*')).toBe('$x$ ![a](b.png) [^1] \\*n\\*');
  });
});

describe('task status helpers', () => {
  it('reads and sets the task box', () => {
    const d = new Doc('- [ ] a\n- [x] b\n- c\n');
    expect([0, 1, 2].map((i) => taskState(d, i))).toEqual([false, true, null]);
    expect(setTask(d, 0, true)).toBe(true);
    expect(setTask(d, 1, true)).toBe(false);
    expect(setTask(d, 2, true)).toBe(false);
    setTask(d, 1, false);
    expect(d.text()).toBe('- [x] a\n- [ ] b\n- c\n');
  });
});

describe('footnotes', () => {
  it('picks the next numeric label', () => {
    expect(nextFootnoteLabel('no notes')).toBe('1');
    expect(nextFootnoteLabel('a[^1] b[^3]\n\n[^3]: x\n[^note]: y')).toBe('4');
  });
  it('finds definitions and references', () => {
    const d = new Doc('Text[^a] more.\n\n[^a]: The *note*.\n');
    expect(footnoteDef(d, 'a')).toMatchObject({ i: 1, text: 'The *note*.' });
    expect(footnoteDef(d, 'zz')).toBeNull();
    expect(footnoteRef(d, 'a')).toEqual({ i: 0, off: 8 });
  });
});
