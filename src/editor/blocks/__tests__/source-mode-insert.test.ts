import { describe, expect, it } from 'vitest';
import { createSourceMode } from '../source-mode';

/**
 * EditorSettings subset used by createSourceMode (keeps the test independent of prefs).
 * Point→position mapping needs real layout (CodeMirror inline measurement) and is
 * covered by the e2e drop test in tests/e2e/parity-files.spec.ts; here we cover
 * the caret fallback, NaN guard, undoability and multi-line inserts.
 */
const settings = { colorScheme: 'light', spellcheck: false } as never;

function make(markdown: string) {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const inst = createSourceMode(host, { markdown, settings, onChange: () => {} });
  return { inst, host };
}

describe('source mode insertAt (#129 OS drops in source mode)', () => {
  it('inserts at the caret as one undo step and leaves the caret after the text', () => {
    const { inst } = make('abc');
    inst.view.dispatch({ selection: { anchor: 3 } });
    expect(inst.insertAt('`x`')).toBe(true);
    expect(inst.getMarkdown()).toBe('abc`x`');
    expect(inst.undo()).toBe(true);
    expect(inst.getMarkdown()).toBe('abc');
    inst.destroy();
  });

  it('multi-line inserts and undefined/NaN points fall back to the caret', () => {
    const { inst } = make('abc');
    inst.view.dispatch({ selection: { anchor: 3 } });
    expect(inst.insertAt('![i](x.png)\n')).toBe(true);
    expect(inst.getMarkdown()).toBe('abc![i](x.png)\n');
    const { inst: n } = make('abc');
    expect(n.insertAt('z', Number.NaN, Number.NaN)).toBe(true);
    expect(n.getMarkdown().startsWith('z')).toBe(true); // caret sits at 0 by default
    n.destroy();
    inst.destroy();
  });
});
