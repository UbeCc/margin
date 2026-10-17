import { describe, it, expect } from 'vitest';
import { History, diff } from './history';
import { Doc } from './model';
import { docHTML } from './html';
import { htmlToMarkdown } from './paste';
import { countStats, findIn, outline } from './query';
import { readText, pointToOffset, offsetToPoint } from './dom';
import { renderContent } from './render-inline';

const ctx = { refs: new Map(), resolveAsset: (s: string) => s, inlineMath: null };

describe('history', () => {
  it('diffs minimally and coalesces typing', () => {
    expect(diff('abc', 'abXc')).toEqual({ from: 2, before: '', after: 'X' });
    const h = new History();
    h.record('a', 'ab', null, null, 'k', 0);
    h.record('ab', 'abc', null, null, 'k', 100);
    expect(h.undos.length).toBe(1);
    expect(h.undos[0]).toMatchObject({ from: 1, before: '', after: 'bc' });
    h.record('abc', 'abcd', null, null, 'k', 5000);
    expect(h.undos.length).toBe(2);
    h.break();
    h.record('abcd', 'abcde', null, null, 'k', 5001);
    expect(h.undos.length).toBe(3);
  });
});

describe('html export', () => {
  it('nests lists and quotes, ids on headings', () => {
    const d = new Doc('# T\n\n- a\n- b\n  - c\n\n> q\n\n1. x\n');
    const h = docHTML(d, ctx, () => null).replace(/\n/g, '');
    expect(h).toContain(`<h1 id="${d.leaves[0].id}">T</h1>`);
    expect(h).toContain('<ul><li><p>a</p></li><li><p>b</p><ul><li><p>c</p></li></ul></li></ul>');
    expect(h).toContain('<blockquote><p>q</p></blockquote>');
    expect(h).toContain('<ol><li><p>x</p></li></ol>');
  });
});

describe('paste html', () => {
  it('converts common markup', () => {
    expect(htmlToMarkdown('<p>a <em>b</em> <a href="u">l</a></p><pre><code class="language-js">x\n</code></pre>')).toBe(
      'a *b* [l](u)\n\n```js\nx\n```',
    );
    expect(htmlToMarkdown('<ol><li>a</li><li>b<ul><li>c</li></ul></li></ol>')).toBe('1. a\n2. b\n\n   - c');
  });
});

describe('queries', () => {
  it('CJK-aware stats, find wraps, outline text', () => {
    expect(countStats('Hello world 你好', 'x\ny\n')).toEqual({ words: 4, characters: 12, lines: 2 });
    expect(findIn('abcabc', 'b', 2, 2)).toBe(4);
    expect(findIn('abcabc', 'b', 5, 5)).toBe(1);
    expect(outline(new Doc('## A *b* ##\n'))[0]).toMatchObject({ level: 2, text: 'A b' });
  });
});

describe('dom mapping', () => {
  it('textContent of rendered content is the source; offsets round-trip', () => {
    const d = new Doc('# Hi **b** ![i](x.png) &amp; `c`\n');
    const el = document.createElement('div');
    renderContent(el, d.leaves[0], '# Hi **b** ![i](x.png) &amp; `c`', ctx);
    const src = '# Hi **b** ![i](x.png) &amp; `c`';
    expect(readText(el)).toBe(src);
    for (let o = 0; o <= src.length; o++) {
      const p = offsetToPoint(el, o);
      expect(pointToOffset(el, p.node, p.offset)).toBe(o);
    }
  });
});
