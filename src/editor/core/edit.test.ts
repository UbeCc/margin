import { describe, it, expect } from 'vitest';
import { Doc, leafContent } from './model';
import { enter, backspace, del, indent, toggleTask, widgetToParagraph, ensureParagraphAfter, type Caret } from './edit';

const at = (d: Doc, c: Caret) => ('pos' in c ? d.locate(c.pos) : c);

describe('enter', () => {
  it('splits a paragraph into two', () => {
    const d = new Doc('abcd\n');
    const c = enter(d, 0, 2);
    expect(d.text()).toBe('ab\n\ncd\n');
    expect(at(d, c)).toEqual({ i: 1, off: 0 });
  });
  it('new list item, then exit list on empty item', () => {
    const d = new Doc('- a\n');
    let c = enter(d, 0, 1);
    expect(d.text()).toBe('- a\n- \n');
    expect(at(d, c)).toEqual({ i: 1, off: 0 });
    c = enter(d, 1, 0);
    expect(d.text()).toBe('- a\n\n');
    expect(d.leaves[1]?.chain.length ?? 0).toBe(0);
  });
  it('ordered + task markers continue', () => {
    const d = new Doc('1. a\n');
    enter(d, 0, 1);
    expect(d.text()).toBe('1. a\n2. \n');
    const t = new Doc('- [x] a');
    enter(t, 0, 1);
    expect(t.text()).toBe('- [x] a\n- [ ] ');
  });
  it('fence / math / table shortcuts become widgets', () => {
    for (const [src, out, type] of [
      ['```js', '```js\n\n```', 'code_fence'],
      ['$$', '$$\n\n$$', 'math_block'],
      ['|a|b|', '|a|b|\n| --- | --- |\n|   |   |', 'table'],
    ]) {
      const d = new Doc('x');
      d.setContent(0, src);
      const c = enter(d, 0, src.length);
      expect(d.text()).toBe(out);
      expect(d.leaves[0].type).toBe(type);
      expect(c).toEqual({ widget: d.leaves[0].id, at: 'start' });
    }
  });
  it('quote paragraphs stay in the quote; soft break', () => {
    const d = new Doc('> ab');
    enter(d, 0, 1);
    expect(d.text()).toBe('> a\n>\n> b');
    const s = new Doc('> ab');
    enter(s, 0, 1, true);
    expect(s.text()).toBe('> a\n> b');
  });
});

describe('backspace / delete', () => {
  it('merges paragraphs', () => {
    const d = new Doc('a\n\nb\n');
    const c = backspace(d, 1, 0)!;
    expect(d.text()).toBe('ab\n');
    expect(at(d, c)).toEqual({ i: 0, off: 1 });
    const e = new Doc('a\n\nb\n');
    del(e, 0, 1);
    expect(e.text()).toBe('ab\n');
  });
  it('removes list marker / heading marker first', () => {
    const d = new Doc('- a\n');
    backspace(d, 0, 0);
    expect(d.text()).toBe('a\n');
    const h = new Doc('## T\n');
    backspace(h, 0, 3);
    expect(h.text()).toBe('T\n');
    expect(h.leaves[0].type).toBe('paragraph');
  });
  it('steps into a previous widget', () => {
    const d = new Doc('```\nx\n```\n\nb\n');
    expect(backspace(d, 1, 0)).toEqual({ widget: d.leaves[0].id, at: 'end' });
  });
});

describe('lists, tasks, widgets', () => {
  it('indents and outdents', () => {
    const d = new Doc('- a\n- b\n');
    indent(d, 1, 0, false);
    expect(d.text()).toBe('- a\n  - b\n');
    indent(d, 1, 0, true);
    expect(d.text()).toBe('- a\n- b\n');
  });
  it('toggles tasks', () => {
    const d = new Doc('- [ ] a\n');
    toggleTask(d, 0);
    expect(d.text()).toBe('- [x] a\n');
  });
  it('widget → empty paragraph; paragraph after last widget', () => {
    const d = new Doc('a\n\n$$\nx\n$$\n');
    widgetToParagraph(d, 1);
    expect(d.text()).toBe('a\n\n\n');
    const e = new Doc('$$\nx\n$$\n');
    const c = ensureParagraphAfter(e, 0);
    expect(e.leaves.length).toBe(2);
    expect(at(e, c)).toEqual({ i: 1, off: 0 });
    expect(leafContent(e.leaves[1])).toBe('');
  });
});
