import { describe, it, expect } from 'vitest';
import { Doc, leafContent, widgetRaw } from './model';

describe('Doc', () => {
  it('lossless set/text incl. CRLF', () => {
    for (const s of ['a\r\n\r\n- b\r\n', '> q\n>\n> r', '']) expect(new Doc(s).text()).toBe(s);
  });
  it('docPos / locate are inverse on content', () => {
    const d = new Doc('# H\n\n> a\n> bc\n\n- x\n  y\n');
    d.leaves.forEach((l, i) => {
      const c = leafContent(l);
      for (let off = 0; off <= c.length; off++) expect(d.locate(d.docPos(i, off))).toEqual({ i, off });
    });
  });
  it('setContent keeps prefixes and converts to heading', () => {
    const d = new Doc('> a\n> b\n\nnext\n');
    const id = d.leaves[0].id;
    d.setContent(0, 'a\nb\nc');
    expect(d.text()).toBe('> a\n> b\n> c\n\nnext\n');
    d.setContent(0, '# a');
    expect(d.text()).toBe('> # a\n\nnext\n');
    expect(d.leaves[0].type).toBe('heading');
    expect(d.leaves[0].id).toBe(id);
  });
  it('holds incomplete triggers', () => {
    const d = new Doc('x\n');
    d.setContent(0, '#');
    expect(d.leaves[0].type).toBe('paragraph');
    d.setContent(0, '```js');
    expect(d.leaves[0].type).toBe('paragraph');
    d.setContent(0, '- a');
    expect(d.leaves[0].chain.length).toBe(1);
    expect(d.text()).toBe('- a\n');
  });
  it('filling an empty paragraph separates it from the next block', () => {
    const d = new Doc('a\n\n\nb\n');
    expect(d.leaves.length).toBe(3);
    d.setContent(1, 'x');
    expect(d.text()).toBe('a\n\nx\n\nb\n');
  });
  it('replace preserves ids of untouched leaves', () => {
    const d = new Doc('a\n\nb\n\nc\n');
    const ids = d.leaves.map((l) => l.id);
    d.replace(3, 4, 'B');
    expect(d.text()).toBe('a\n\nB\n\nc\n');
    expect(d.leaves.map((l) => l.id)).toEqual(ids);
  });
  it('widget raw round-trip with prefixes', () => {
    const d = new Doc('> ```\n> x\n> ```\n\np');
    expect(widgetRaw(d.leaves[0])).toBe('```\nx\n```\n\n');
    d.setWidgetRaw(0, '```\nx\ny\n```\n\n');
    expect(d.text()).toBe('> ```\n> x\n> y\n> ```\n\np');
  });
  it('setWidgetRaw with unchanged raw is identity for every widget leaf', () => {
    const docs = [
      '```js\nx\n```\n\n\np', '> $$\n> a\n> $$\n>\n> q', '- ```\n  a\n  ```\n\n- b', '| a | b |\n|---|---|\n| 1 | 2 |',
      '---\nt: 1\n---\n\n# h', '<div>\nx\n</div>\n\nz', '[toc]\n', '> > ~~~\n> > k\n> > ~~~',
    ];
    for (const s of docs) {
      const d = new Doc(s);
      d.leaves.forEach((l, i) => {
        if (l.type === 'paragraph' || l.type === 'heading') return;
        d.setWidgetRaw(i, widgetRaw(l));
        expect(d.text()).toBe(s);
      });
    }
  });
  it('widget edit adds trailing blank lines with container prefixes', () => {
    const d = new Doc('> ```\n> a\n> ```\n> q\n');
    d.setWidgetRaw(0, '```\na\nb\n```\n\n');
    expect(d.text()).toBe('> ```\n> a\n> b\n> ```\n>\n> q\n');
  });
  it('refs', () => {
    expect(new Doc('[A b]: /u "t"\n').refs().get('a b')).toEqual({ href: '/u', title: 't' });
  });
});
