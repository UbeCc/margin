import { describe, expect, it } from 'vitest';
import { recompute, registerEquation, resolveLabel, stripLabels, substituteRefs } from './math-refs';
import { inlineMathHTML, prepareTex, renderTexSafe } from './math';

describe('equation labels and references (#7)', () => {
  it('strips \\label and substitutes refs', () => {
    expect(stripLabels('x \\label{eq:a} = 1')).toEqual({ tex: 'x  = 1', labels: ['eq:a'] });
    expect(substituteRefs('see \\eqref{a} and \\ref{b}', (n) => (n === 'a' ? '3' : null))).toBe('see \\text{(3)} and \\text{??}');
  });
  it('labelled formulas render instead of erroring', () => {
    expect(renderTexSafe(prepareTex('E = mc^2 \\label{einstein}'), true).error).toBeNull();
    expect(renderTexSafe(prepareTex('\\begin{align} a &= b \\label{q} \\end{align}'), true).error).toBeNull();
    expect(inlineMathHTML('\\eqref{nope}')).toContain('(??)');
  });
  it('numbers equations in document order; \\tag wins; refs resolve', () => {
    const root = document.createElement('div');
    document.body.append(root);
    const a = document.createElement('div');
    const b = document.createElement('div');
    const c = document.createElement('div');
    root.append(a, b, c);
    registerEquation(c, 'z \\label{last}', true);
    registerEquation(a, 'x \\label{first}', true);
    registerEquation(b, 'y \\tag{*} \\label{star}', true);
    recompute();
    expect([a.dataset.eq, b.dataset.eq, c.dataset.eq]).toEqual(['1', '*', '2']);
    expect(resolveLabel('last')).toBe('2');
    expect(resolveLabel('star')).toBe('*');
    expect(inlineMathHTML('\\eqref{last}')).toContain('(2)');
    root.remove();
  });
});
