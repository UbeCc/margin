import { describe, it, expect } from 'vitest';
import { parseBlocks, serializeLeaves } from './block';
import type { ItemContainer } from '../types';

const types = (s: string) => parseBlocks(s).map((l) => l.type);
const rt = (s: string) => expect(serializeLeaves(parseBlocks(s))).toBe(s);

const SAMPLES = [
  '',
  '\n',
  '\n\n\n',
  'hello',
  'hello\n',
  'a\r\nb\r\n\r\nc',
  'a\rb\r',
  '# H1\n\nText *em* **strong**\n',
  'Setext\n===\n\nTwo\n---\n',
  '---\ntitle: x\n---\n\n# Doc\n',
  '- a\n- b\n  - c\n    - d\n\n1. one\n2. two\n',
  '- [ ] todo\n- [x] done\n  continuation\n',
  '> quote\n> more\nlazy\n>\n> > nested\n',
  '```js\nconst a = 1;\n\n```\n\ntext',
  '~~~~\nunclosed fence\n',
  '$$\nE=mc^2\n$$\n',
  '$$ x $$\n',
  '| a | b |\n|---|:-:|\n| 1 | 2 |\n\nafter',
  '<div>\n<p>hi</p>\n</div>\n\npara',
  '<!-- c\nstill -->\n',
  '[toc]\n\n# A\n## B\n',
  'Text[^1]\n\n[^1]: Note.\n[ref]: http://x "t"\n',
  '    indented code\n    more\n\npara',
  '\t- tab list\n\t\tdeep\n',
  '- a\n\n\n\n- b',
  '   \n  \t\nx  \n',
  '* * *\n___\n- - -\n',
  '> ```\n> code\n> ```\n',
  '1) a\n2) b\n10. c\n',
  '-\n  foo\n',
  'para\n    not code\n',
  '- ```\n  x\n  ```\n- y',
];

describe('block parser round-trip', () => {
  for (const s of SAMPLES) it(JSON.stringify(s).slice(0, 50), () => rt(s));

  it('fuzz', () => {
    const atoms = ['\n', '\r\n', ' ', '  ', '\t', '#', '# ', '>', '> ', '-', '- ', '* ', '1. ', '2) ', '[ ] ', '[x] ', '```', '~~~', '$$', '|', '---', '===', '<div>', '<!--', '-->', '[toc]', '[^1]: ', '[a]: u', 'a', 'b c', '*', '_', '`', '\\', 'x'];
    let seed = 42;
    const rnd = (n: number) => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) % n);
    for (let k = 0; k < 3000; k++) {
      let s = '';
      const len = rnd(40);
      for (let i = 0; i < len; i++) s += atoms[rnd(atoms.length)];
      expect(serializeLeaves(parseBlocks(s))).toBe(s);
    }
  });
});

describe('block structure', () => {
  it('headings', () => {
    const l = parseBlocks('# A\nB\n==\n');
    expect(l.map((x) => [x.type, x.level])).toEqual([['heading', 1], ['heading', 1]]);
    expect(l[1].setext).toBe(true);
  });
  it('blank lines: one trailing, extra become empty paragraphs', () => {
    const l = parseBlocks('a\n\n\nb\n');
    expect(l.map((x) => [x.type, x.n, x.lines.length])).toEqual([['paragraph', 1, 2], ['paragraph', 1, 1], ['paragraph', 1, 1]]);
  });
  it('lists and tasks', () => {
    const l = parseBlocks('- [ ] a\n- [x] b\n  - c\n');
    expect(l.length).toBe(3);
    const it0 = l[0].chain[0] as ItemContainer;
    expect(it0.task).toBe(' ');
    expect(l[0].lines[0]).toEqual({ prefix: '- [ ] ', text: 'a', eol: '\n' });
    expect((l[1].chain[0] as ItemContainer).task).toBe('x');
    expect(l[2].chain.length).toBe(2);
    expect(l[2].lines[0].prefix).toBe('  - ');
    expect((l[1].chain[0] as ItemContainer).listKey).toBe(it0.listKey);
  });
  it('ordered numbering', () => {
    const l = parseBlocks('3. a\n7. b\n');
    expect(l.map((x) => (x.chain[0] as ItemContainer).number)).toEqual([3, 4]);
  });
  it('quotes with lazy continuation', () => {
    const l = parseBlocks('> a\nb\n\n> c');
    expect(l.length).toBe(2);
    expect(l[0].n).toBe(2);
    expect(l[0].chain[0].kind).toBe('quote');
    expect(l[0].chain[0]).not.toBe(l[1].chain[0]);
  });
  it('widget types', () => {
    expect(types('---\na: 1\n---\n```\nx\n```\n$$\ny\n$$\n|a|\n|-|\n<div>\n</div>\n\n[toc]\n***\n')).toEqual([
      'front_matter', 'code_fence', 'math_block', 'table', 'html_block', 'toc', 'hr',
    ]);
  });
  it('fence inside list item', () => {
    const l = parseBlocks('- ```\n  x\n  ```\n- y');
    expect(l.map((x) => x.type)).toEqual(['code_fence', 'paragraph']);
    expect(l[0].lines.map((x) => x.text)).toEqual(['```', 'x', '```']);
  });
  it('defs', () => {
    expect(types('[a]: /u\n[^1]: n\n')).toEqual(['def', 'footnote']);
  });
  it('indented code does not interrupt paragraph', () => {
    expect(types('p\n    q\n\n    code')).toEqual(['paragraph', 'indented_code']);
  });
});
