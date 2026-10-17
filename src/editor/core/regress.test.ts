/** Regression tests for editor-core bugs found by QA (issue numbers in titles). */
import { describe, it, expect } from 'vitest';
import { Doc, leafContent } from './model';
import { enter, backspace, indent, type Caret } from './edit';
import { modelProblems } from './test-util';

const at = (d: Doc, c: Caret) => ('pos' in c ? d.locate(c.pos) : c);
const ok = (d: Doc) => expect(modelProblems(d)).toEqual([]);

describe('Enter at the end of a document without a final newline (#49)', () => {
  it('creates a new empty block after a paragraph / heading', () => {
    for (const src of ['a', '# Title', '---']) {
      const d = new Doc(src);
      const c = enter(d, 0, leafContent(d.leaves[0]).length);
      expect(d.leaves.length, src).toBe(2);
      expect(at(d, c), src).toEqual({ i: 1, off: 0 });
      ok(d);
    }
  });
  it('typing after it lands in the new block', () => {
    const d = new Doc('# Title');
    const c = enter(d, 0, 7);
    const { i } = at(d, c) as { i: number };
    d.setContent(i, 'Para');
    expect(d.text()).toBe('# Title\n\nPara\n');
    ok(d);
  });
  it('Enter on an empty last list item exits the list into a new block', () => {
    const d = new Doc('# H\n- ');
    const c = enter(d, 1, 0);
    expect(at(d, c)).toEqual({ i: 1, off: 0 });
    expect(d.leaves[1].chain.length).toBe(0);
    ok(d);
  });
});

describe('Enter on an empty paragraph (#50)', () => {
  it('adds exactly one empty block', () => {
    const d = new Doc('a\n\n\nb\n');
    expect(d.leaves.length).toBe(3);
    const c = enter(d, 1, 0);
    expect(d.text()).toBe('a\n\n\n\nb\n');
    expect(d.leaves.length).toBe(4);
    expect(at(d, c)).toEqual({ i: 2, off: 0 });
    ok(d);
  });
});

describe('task items typed by hand (#51)', () => {
  it('`[ ] ` after a list marker makes a task item', () => {
    const d = new Doc('- \n');
    // typed one character at a time, like the browser does
    for (const ch of '[ ] task') d.setContent(0, leafContent(d.leaves[0]) + ch);
    expect(d.leaves[0].chain[0]).toMatchObject({ kind: 'item', task: ' ' });
    expect(leafContent(d.leaves[0])).toBe('task');
    enter(d, 0, 4);
    expect(d.text()).toBe('- [ ] task\n- [ ] \n');
    ok(d);
  });
});

describe('outdent inside a block quote keeps `> ` (#52)', () => {
  it('Shift+Tab / Backspace on a top-level item in a quote', () => {
    const d = new Doc('> - a\n> - b\n');
    indent(d, 1, 0, true);
    expect(d.text()).toBe('> - a\n> b\n');
    const e = new Doc('> - a\n');
    backspace(e, 0, 0);
    expect(e.text()).toBe('> a\n');
    ok(d);
    ok(e);
  });
});

describe('caret / model after splits whose remainder is block syntax', () => {
  it('Enter before `> x` puts the caret into the new quote content', () => {
    const d = new Doc('ab> x\n');
    const c = enter(d, 0, 2);
    expect(d.leaves[1].chain[0]?.kind).toBe('quote');
    expect(at(d, c)).toEqual({ i: 1, off: 0 });
    ok(d);
  });
  it('Shift+Enter at the start of a paragraph keeps the caret before the text', () => {
    const d = new Doc('a\n\nxyz\n');
    const c = enter(d, 1, 0, true);
    expect(d.text()).toBe('a\n\n\nxyz\n');
    const p = at(d, c) as { i: number; off: number };
    expect(leafContent(d.leaves[p.i])).toBe('xyz');
    expect(p.off).toBe(0);
    ok(d);
  });
});

describe('model follows container syntax changed by content edits (#53)', () => {
  it('deleting the last `#` turns the empty heading into a paragraph', () => {
    const d = new Doc('# x\n\nb\n');
    d.setContent(0, '#');
    d.setContent(0, '');
    expect(d.leaves[0].type).toBe('paragraph');
  });
  it('indenting a paragraph under a list item joins the item', () => {
    const d = new Doc('- a\n\npara\n');
    d.setContent(1, '  para');
    expect(d.leaves[1].chain.length).toBe(1);
    ok(d);
  });
  it('a space typed after `>` is part of the quote marker', () => {
    const d = new Doc('>a\n');
    d.setContent(0, ' a');
    expect(d.leaves[0].lines[0].prefix).toBe('> ');
    ok(d);
  });
});

describe('leaving a block quote with Enter on an empty quote line (#58)', () => {
  it('does not leave a dangling `>` line', () => {
    const d = new Doc('> quoted');
    let c = enter(d, 0, 6);
    c = enter(d, (at(d, c) as { i: number }).i, 0);
    expect(d.text()).toBe('> quoted\n\n\n');
    expect(at(d, c)).toEqual({ i: 1, off: 0 });
    ok(d);
  });
});

describe('Enter at the start of a heading (#58)', () => {
  it('opens an empty paragraph above and keeps the heading', () => {
    for (const [src, out] of [
      ['p\n\n# Head\n', 'p\n\n\n# Head\n'],
      ['p\n# Head\n', 'p\n\n\n# Head\n'],
      ['# Head\n', '\n# Head\n'],
    ]) {
      const d = new Doc(src);
      const i = d.leaves.findIndex((l) => l.type === 'heading');
      const c = enter(d, i, 2);
      expect(d.text(), src).toBe(out);
      const p = at(d, c) as { i: number; off: number };
      expect(d.leaves[p.i].type, src).toBe('heading');
      expect(p.off).toBe(2);
      expect(d.leaves[p.i - 1].type).toBe('paragraph');
      ok(d);
    }
  });
});

describe('windowed re-parse for structural edits in large documents (#33)', () => {
  const big = Array.from({ length: 200 }, (_, k) => `para ${k}\n\n- item ${k}\n- b\n\n`).join('');
  it('Enter / replace in the middle does not re-parse the whole document', () => {
    const d = new Doc(big);
    const full = d.reparse.bind(d);
    let fulls = 0;
    d.reparse = (md: string) => {
      fulls++;
      full(md);
    };
    const i = d.leaves.findIndex((l) => leafContent(l) === 'item 100');
    const id = d.leaves[i + 5].id;
    enter(d, i, 4);
    d.replace(d.start(i), d.start(i), '# New\n\n');
    expect(fulls).toBe(0);
    expect(d.leaves.find((l) => l.id === id)).toBeTruthy();
    ok(d);
  });
  it('falls back to a full re-parse when an unclosed fence swallows the rest', () => {
    const d = new Doc(big);
    const i = d.leaves.findIndex((l) => leafContent(l) === 'para 50');
    d.replace(d.start(i), d.start(i), '```\n');
    expect(d.leaves[i].type).toBe('code_fence');
    expect(d.leaves.length).toBeLessThan(i + 3);
    ok(d);
  });
});

describe('Tab / Shift+Tab move the whole item subtree (#34)', () => {
  const run = (src: string, text: string, out: boolean) => {
    const d = new Doc(src);
    const i = d.leaves.findIndex((l) => leafContent(l) === text);
    const c = indent(d, i, 1, out)!;
    expect(at(d, c)).toMatchObject({ off: 1 });
    ok(d);
    return d.text();
  };
  it('indent carries nested items and continuation paragraphs', () => {
    expect(run('- a\n- b\n  - c\n  - d\n- e\n', 'b', false)).toBe('- a\n  - b\n    - c\n    - d\n- e\n');
    expect(run('- a\n- b\n\n  cont\n- e\n', 'b', false)).toBe('- a\n  - b\n\n    cont\n- e\n');
    expect(run('> - a\n> - b\n>   - c\n', 'b', false)).toBe('> - a\n>   - b\n>     - c\n');
  });
  it('outdent carries them back; lazy lines untouched', () => {
    expect(run('- a\n  - b\n    - c\n  para\n- e\n', 'b', true)).toBe('- a\n- b\n  - c\n  para\n- e\n');
    expect(run('1. a\n   1. b\n      - c\n', 'b', true)).toBe('1. a\n1. b\n   - c\n');
  });
});
