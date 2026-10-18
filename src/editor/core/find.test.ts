import { describe, it, expect } from 'vitest';
import { Doc, widgetRaw } from './model';
import { rawOffset } from './find';

/** For every match of `q` in the document source inside leaf `type`, the mapped raw slice equals `want`. */
function check(md: string, type: string, q: string, want = q) {
  const d = new Doc(md);
  const text = d.text();
  const at = text.indexOf(q);
  expect(at).toBeGreaterThanOrEqual(0);
  const { i } = d.locate(at);
  const l = d.leaves[i];
  expect(l.type).toBe(type);
  const raw = widgetRaw(l);
  const base = d.start(i);
  const a = rawOffset(l.lines, base, at);
  const b = rawOffset(l.lines, base, at + q.length);
  expect(raw.slice(a, b)).toBe(want);
}

describe('rawOffset (doc position → widget raw offset, #35)', () => {
  it('maps plain widgets', () => {
    check('para\n\n```js\nconst x = 1;\n```\n\nend\n', 'code_fence', 'x = 1');
    check('| a | b |\n| - | - |\n| cell | z |\n', 'table', 'cell');
    check('$$\nE=mc^2\n$$\n', 'math_block', 'mc^2');
  });

  it('strips container prefixes (quotes, list items)', () => {
    check('> ```\n> foo\n> bar\n> ```\n', 'code_fence', 'foo\n> bar', 'foo\nbar');
    check('- item\n\n  ```\n  inner code\n  ```\n', 'code_fence', 'inner code');
    check('> | h |\n> | - |\n> | deep |\n', 'table', 'deep');
  });

  it('handles CRLF line endings', () => {
    check('```\r\nab\r\ncd\r\n```\r\n', 'code_fence', 'ab\r\ncd', 'ab\ncd');
  });

  it('clamps positions inside a prefix to the line start', () => {
    const d = new Doc('> $$\n> x\n> $$\n');
    const l = d.leaves[0];
    expect(rawOffset(l.lines, 0, 6)).toBe(3); // inside "> " of line 2 → start of "x"
    expect(widgetRaw(l).slice(3, 4)).toBe('x');
  });
});
