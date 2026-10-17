import { describe, it, expect } from 'vitest';
import { parseInline, inlineSource, inlinePlain, INode } from './inline';

const shape = (ns: INode[]): unknown[] =>
  ns.map((n) => (n.k === 'wrap' ? { [n.tag]: shape(n.ch) } : n.k === 'text' || n.k === 'meta' ? `${n.k}:${n.v}` : n.k));

describe('inline parser', () => {
  const cases = [
    'plain', '*em*', '**strong**', '***both***', '_u_ and __uu__', 'a*b*c', 'snake_case_word', '`code *x*`', '``a`b``',
    '~~del~~', '~one~', '==mark==', '=no=', '[link](http://x "t")', '[a [b] c](u)', '![img](a.png)', '<http://a.b>', '<a@b.co>',
    '<span class="x">hi</span>', '&amp; &copy; &#35; &bogus;', '\\*not\\*', 'hard  \nbreak', 'soft\nbreak', 'back\\\nslash',
    '$x^2$ and $5 or $6', 'see https://example.com/a?b. ok', '[^1] note', '[ref] and [ref][] and [x][ref]', '**unclosed', '*a **b** c*',
    '[unclosed](', '](', '``', '\\', '$$', 'a == b', '*', '_*_*', '**a*', '<!-- c -->', '[`]`](u)',
  ];
  const refs = new Map([['ref', { href: '/r' }]]);
  for (const c of cases) it(`source round-trip ${JSON.stringify(c)}`, () => expect(inlineSource(parseInline(c, refs))).toBe(c));

  it('fuzz', () => {
    const atoms = ['*', '**', '_', '__', '~~', '==', '`', '[', ']', '(', ')', '!', '<', '>', '$', '\\', ' ', '\n', 'a', 'http://x', '&amp;', '"'];
    let seed = 7;
    const rnd = (n: number) => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) % n);
    for (let k = 0; k < 3000; k++) {
      let s = '';
      for (let i = rnd(30); i > 0; i--) s += atoms[rnd(atoms.length)];
      expect(inlineSource(parseInline(s, refs))).toBe(s);
    }
  });

  it('structure', () => {
    expect(shape(parseInline('*a* **b**'))).toEqual([{ em: ['meta:*', 'text:a', 'meta:*'] }, 'text: ', { strong: ['meta:**', 'text:b', 'meta:**'] }]);
    expect(shape(parseInline('***x***'))).toEqual([{ em: ['meta:*', { strong: ['meta:**', 'text:x', 'meta:**'] }, 'meta:*'] }]);
    expect(shape(parseInline('snake_case_word'))).toEqual(['text:snake_case_word']);
    expect(shape(parseInline('~~d~~ ==m=='))).toEqual([{ del: ['meta:~~', 'text:d', 'meta:~~'] }, 'text: ', { mark: ['meta:==', 'text:m', 'meta:=='] }]);
    const l = parseInline('[a *b*](u "t")')[0];
    expect(l.k === 'wrap' && l.href).toBe('u');
    expect(l.k === 'wrap' && l.title).toBe('t');
    expect(parseInline('$x$')[0].k).toBe('math');
    expect(parseInline('![a](b.png)')[0]).toMatchObject({ k: 'image', src: 'b.png', alt: 'a' });
    expect(parseInline('[r]', new Map([['r', { href: '/x' }]]))[0]).toMatchObject({ k: 'wrap', href: '/x' });
    expect(parseInline('[r]')[0].k).toBe('text');
  });

  it('plain text', () => {
    expect(inlinePlain(parseInline('**a** `b` [c](d) &amp;'))).toBe('a b c &');
  });
});
