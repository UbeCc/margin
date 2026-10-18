import { describe, expect, it } from 'vitest';
import { diffRange } from './commands';

const apply = (old: string, r: { from: number; to: number; text: string }) => old.slice(0, r.from) + r.text + old.slice(r.to);

describe('diffRange (#89 caret-preserving replaceDocument)', () => {
  it('replaces only the changed middle', () => {
    expect(diffRange('# A\n\nbody\n', '# B\n\nbody\n')).toEqual({ from: 2, to: 3, text: 'B' });
    expect(diffRange('abc', 'abXc')).toEqual({ from: 2, to: 2, text: 'X' });
    expect(diffRange('abc', '')).toEqual({ from: 0, to: 3, text: '' });
  });
  it('never splits a surrogate pair and always round-trips', () => {
    for (const [a, b] of [['x😀y', 'x😃y'], ['😀', '😃'], ['aa', 'aaa'], ['', 'z'], ['ab😀', 'ab😀😀']]) {
      const r = diffRange(a, b);
      expect(apply(a, r)).toBe(b);
      expect(/[\uDC00-\uDFFF]/.test(r.text[0] ?? '')).toBe(false);
    }
  });
});
