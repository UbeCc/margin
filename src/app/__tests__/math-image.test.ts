/** #127: math copy-as-image page builder + "Use LaTeX Source" inline rendering. */
import { describe, expect, it } from 'vitest';
import { blockInlineHTML } from '../../editor/core/html';
import { mathImagePage } from '../math-image';

const ctx = { refs: new Map(), resolveAsset: (s: string) => s, inlineMath: null };

describe('math copy (#127)', () => {
  it('"Use LaTeX Source": inline math keeps its $…$ source (rendered spans suppressed)', () => {
    const src = { ...ctx, mathSource: true, inlineMath: () => {} };
    expect(blockInlineHTML('a $x^2$ b', src)).toBe('a <span class="md-math">$x^2$</span> b');
    // without the flag the tex renders escaped (no $ delimiters), as before
    expect(blockInlineHTML('a $x^2$ b', ctx)).toBe('a <span class="md-math">x^2</span> b');
  });

  it('mathImagePage wraps the KaTeX HTML in a transparent standalone page', () => {
    const p = mathImagePage('<span class="katex">…</span>', 'K', true);
    expect(p).toContain('<!DOCTYPE html>');
    expect(p).toContain('<style>K</style>');
    expect(p).toContain('<div class="m"><span class="katex">…</span></div>');
    expect(p).toContain('background:transparent');
    expect(mathImagePage('<i/>', 'K', false)).toContain('<span class="m"><i/></span>');
  });
});
