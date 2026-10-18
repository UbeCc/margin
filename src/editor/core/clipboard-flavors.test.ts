/** Copy flavours and paste priority (#79). */
import { describe, it, expect } from 'vitest';
import { MARGIN_MIME, buildCopyFlavors, embeddedMarkdown, pickPasteMarkdown, writeFlavors } from './clipboard-flavors';
import { htmlToMarkdown } from './paste';

const getter = (d: Record<string, string>) => (t: string) => d[t] ?? '';
const MD = '# T\n\n- a **b** "q" <x> & y\n';

describe('copy flavours', () => {
  it('plain is the markdown; HTML carries it losslessly in the marker; nonce embedded', () => {
    const f = buildCopyFlavors(MD, '<h1>T</h1>', 'n-1');
    expect(f.plain).toBe(MD);
    expect(f.markdown).toBe(MD);
    expect(f.html).toContain('data-margin-copy="n-1"');
    expect(f.html).toContain('<h1>T</h1>');
    expect(embeddedMarkdown(f.html)).toBe(MD);
  });
  it('writeFlavors sets plain, html and the private type', () => {
    const set = new Map<string, string>();
    const dt = { setData: (t: string, v: string) => void set.set(t, v) } as unknown as DataTransfer;
    writeFlavors(dt, buildCopyFlavors(MD, '<p>x</p>'));
    expect([...set.keys()]).toEqual(['text/plain', 'text/html', MARGIN_MIME]);
  });
  it('writeFlavors survives engines rejecting custom types', () => {
    const set = new Map<string, string>();
    const dt = {
      setData: (t: string, v: string) => {
        if (t === MARGIN_MIME) throw new Error('nope');
        set.set(t, v);
      },
    } as unknown as DataTransfer;
    writeFlavors(dt, buildCopyFlavors(MD, '<p>x</p>'));
    expect(set.size).toBe(2);
  });
  it('embeddedMarkdown: regex fallback without DOMParser decodes entities', () => {
    const html = buildCopyFlavors(MD, '<p>x</p>').html;
    const DP = globalThis.DOMParser;
    // @ts-expect-error simulate a DOM-less environment
    delete globalThis.DOMParser;
    try {
      expect(embeddedMarkdown(html)).toBe(MD);
      expect(embeddedMarkdown('<p>no marker</p>')).toBeNull();
    } finally {
      globalThis.DOMParser = DP;
    }
  });
});

describe('paste priority', () => {
  const html = buildCopyFlavors(MD, '<h1>T</h1><ul><li>a</li></ul>').html;
  it('private flavour wins over everything', () => {
    const r = pickPasteMarkdown(getter({ [MARGIN_MIME]: 'PRIV', 'text/html': html, 'text/plain': 'plain' }), htmlToMarkdown);
    expect(r).toEqual({ md: 'PRIV', source: 'margin' });
  });
  it('markdown embedded in Margin HTML beats plain text (custom type stripped)', () => {
    const r = pickPasteMarkdown(getter({ 'text/html': html, 'text/plain': 'flattened' }), htmlToMarkdown);
    expect(r).toEqual({ md: MD, source: 'margin-html' });
  });
  it('old Margin HTML (empty marker) uses text/plain, not HTML conversion', () => {
    const r = pickPasteMarkdown(getter({ 'text/html': '<div data-margin-md=""><p><b>x</b></p></div>', 'text/plain': '**x**' }), htmlToMarkdown);
    expect(r).toEqual({ md: '**x**', source: 'plain' });
  });
  it('foreign rich HTML is converted; failures fall back to plain', () => {
    expect(pickPasteMarkdown(getter({ 'text/html': '<p><b>x</b></p>', 'text/plain': 'x' }), htmlToMarkdown)).toEqual({ md: '**x**', source: 'html' });
    const boom = () => {
      throw new Error('bad');
    };
    expect(pickPasteMarkdown(getter({ 'text/html': '<p>x</p>', 'text/plain': 'x' }), boom)).toEqual({ md: 'x', source: 'plain' });
  });
  it('a getter that throws for the private type is tolerated', () => {
    const get = (t: string) => {
      if (t === MARGIN_MIME) throw new Error('denied');
      return t === 'text/plain' ? 'p' : '';
    };
    expect(pickPasteMarkdown(get, htmlToMarkdown)).toEqual({ md: 'p', source: 'plain' });
  });
});
