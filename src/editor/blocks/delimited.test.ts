import { describe, expect, it } from 'vitest';
import {
  buildMathRaw,
  buildRaw,
  buildFenceRaw,
  buildHtmlRaw,
  fenceLang,
  makeFence,
  parseFence,
  parseFrontMatter,
  parseHtmlBlock,
  parseMathBlock,
  withFenceInfo,
} from './util/delimited';

const FENCES = [
  '```\n```\n',
  '```\n```',
  '```\n\n```\n',
  '```js\nconst a = 1;\n```\n',
  '```js\nconst a = 1;\n```\n\n\n',
  '``` js  {.numberLines startFrom="3"}\na\nb\n```\n',
  '~~~~python\nprint(1)\n```\nstill code\n~~~~\n',
  '````md\n```js\nx\n```\n````\n',
  '   ```\n   indented\n  less\n     more\n   ```\n',
  '```js\nunclosed\n',
  '```js\nunclosed no newline',
  '```js',
  '```\na\n\n\nb\n```  \n',
  '```\r\nwindows\r\n```\r\n',
  '```\n  ```  \n',
];

describe('code fence envelope', () => {
  it.each(FENCES)('round-trips unchanged %j', (raw) => {
    const p = parseFence(raw);
    expect(buildRaw(p, p.body)).toBe(raw);
    expect(withFenceInfo(p, p.info)).toBe(raw);
    expect(p.head + p.raw.slice(p.head.length)).toBe(raw);
  });

  it('extracts info, lang and body', () => {
    const p = parseFence('``` js  {.numberLines}\na\nb\n```\n\n');
    expect(p.info).toBe(' js  {.numberLines}');
    expect(p.lang).toBe('js');
    expect(p.body).toBe('a\nb');
    expect(p.char).toBe('`');
    expect(p.length).toBe(3);
    expect(p.tail).toBe('```\n\n');
    expect(p.closed).toBe(true);
  });

  it('requires closing fence at least as long and of same char', () => {
    const p = parseFence('~~~~python\nprint(1)\n```\n~~~\nstill code\n~~~~~\n');
    expect(p.body).toBe('print(1)\n```\n~~~\nstill code');
    expect(p.tail).toBe('~~~~~\n');
  });

  it('edits body preserving fence, info and trailing lines', () => {
    const p = parseFence('~~~~ py\nold\n~~~~\n\n');
    expect(buildRaw(p, 'new\nlines')).toBe('~~~~ py\nnew\nlines\n~~~~\n\n');
    expect(buildRaw(p, '')).toBe('~~~~ py\n~~~~\n\n');
  });

  it('adds body to an empty fence', () => {
    const p = parseFence('```\n```\n');
    expect(p.body).toBe('');
    expect(buildRaw(p, 'x')).toBe('```\nx\n```\n');
  });

  it('strips and re-applies indentation', () => {
    const p = parseFence('  ```\n  a\n    b\n\n  ```\n');
    expect(p.body).toBe('a\n  b\n');
    expect(buildRaw(p, 'a\n  b\n\nc')).toBe('  ```\n  a\n    b\n\n  c\n  ```\n');
  });

  it('handles unclosed fences', () => {
    const p = parseFence('```js\nunclosed\n\n');
    expect(p.closed).toBe(false);
    expect(p.body).toBe('unclosed');
    expect(buildRaw(p, 'changed')).toBe('```js\nchanged\n\n');
    const q = parseFence('```js');
    expect(q.body).toBe('');
    expect(buildRaw(q, 'x')).toBe('```js\nx');
  });

  it('changes info string only', () => {
    const p = parseFence('   ````js\n   x\n   ````\n');
    expect(withFenceInfo(p, 'python')).toBe('   ````python\n   x\n   ````\n');
    expect(withFenceInfo(parseFence('```js\nx\n```'), 'a`b')).toBe('```ab\nx\n```');
    expect(withFenceInfo(parseFence('~~~js\nx\n~~~'), 'a`b')).toBe('~~~a`b\nx\n~~~');
  });

  it('fenceLang normalizes', () => {
    expect(fenceLang(' JS ')).toBe('js');
    expect(fenceLang('{.python .numberLines}')).toBe('python');
    expect(fenceLang('')).toBe('');
  });

  it('makeFence picks a long enough fence', () => {
    expect(makeFence('a ``` b', 'md')).toBe('````md\na ``` b\n````\n');
    expect(parseFence(makeFence('x\n`````\ny')).body).toBe('x\n`````\ny');
  });
});

describe('math block envelope', () => {
  const CASES = ['$$\nx^2\n$$\n', '$$\n$$\n', '$$\n\\int\n\n$$\n\n', '$$ a+b $$\n', '$$x$$', '  $$\n  y\n  $$\n', '$$\nunclosed\n'];
  it.each(CASES)('round-trips %j', (raw) => {
    const p = parseMathBlock(raw);
    expect(buildMathRaw(p, p.body)).toBe(raw);
  });
  it('edits multi-line and single-line forms', () => {
    expect(buildMathRaw(parseMathBlock('$$\nx\n$$\n\n'), 'y')).toBe('$$\ny\n$$\n\n');
    const one = parseMathBlock('$$ a+b $$\n');
    expect(one.body).toBe(' a+b ');
    expect(buildMathRaw(one, ' c ')).toBe('$$ c $$\n');
    expect(buildMathRaw(one, 'a\nb')).toBe('$$\na\nb\n$$\n');
  });
});

describe('front matter & html envelopes', () => {
  it('front matter round-trip + edit', () => {
    const raw = '---\ntitle: x\ntags: [a]\n---\n\n';
    const p = parseFrontMatter(raw);
    expect(p.body).toBe('title: x\ntags: [a]');
    expect(buildRaw(p, p.body)).toBe(raw);
    expect(buildRaw(p, 'title: y')).toBe('---\ntitle: y\n---\n\n');
    expect(parseFrontMatter('---\na: 1\n...\n').body).toBe('a: 1');
  });
  it('html round-trip + edit', () => {
    const raw = '<div>\n  hi\n</div>\n\n';
    const p = parseHtmlBlock(raw);
    expect(p.body).toBe('<div>\n  hi\n</div>');
    expect(buildHtmlRaw(p, p.body)).toBe(raw);
    expect(buildHtmlRaw(p, '<p>x</p>')).toBe('<p>x</p>\n\n');
    expect(buildHtmlRaw(parseHtmlBlock('<br>'), '<hr>')).toBe('<hr>\n');
  });
});

describe('buildFenceRaw keeps the fence intact', () => {
  it('lengthens the fence when the body contains a closing-fence line', () => {
    const p = parseFence('```js\nx\n```\n\n');
    const raw = buildFenceRaw(p, 'x\n```\ny');
    expect(raw).toBe('````js\nx\n```\ny\n````\n\n');
    expect(parseFence(raw).body).toBe('x\n```\ny');
  });
  it('handles tildes, longer runs, indent and unclosed fences', () => {
    expect(buildFenceRaw(parseFence('~~~\na\n~~~\n'), 'a\n~~~~~')).toBe('~~~~~~\na\n~~~~~\n~~~~~~\n');
    expect(buildFenceRaw(parseFence('  ```\n  a\n  ```\n'), 'a\n```')).toBe('  ````\n  a\n  ```\n  ````\n');
    expect(buildFenceRaw(parseFence('```\na\n'), 'a\n```')).toBe('````\na\n```\n');
  });
  it('leaves fences alone when no body line could close them', () => {
    const p = parseFence('```js\nx\n```\n');
    expect(buildFenceRaw(p, 'x\n``` not a close\n~~~')).toBe('```js\nx\n``` not a close\n~~~\n```\n');
    expect(buildFenceRaw(p, 'x')).toBe(p.raw);
  });
});
