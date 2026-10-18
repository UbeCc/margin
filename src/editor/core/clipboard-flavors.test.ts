/** Copy flavours and paste priority (#79). */
import { describe, it, expect } from 'vitest';
import { MARGIN_MIME, buildCopyFlavors, embeddedMarkdown, pickPasteMarkdown, writeFlavors } from './clipboard-flavors';
import { htmlToMarkdown } from './paste';
import { expandToBlockStart, extractDataImages, storeDataImages } from './clipboard';
import type { EditorCore } from './editor';
import { Doc } from './model';

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

describe('copy range widening (expandToBlockStart)', () => {
  const at = (src: string, from: string, to: string) => {
    const d = new Doc(src);
    const f = src.indexOf(from);
    const t = src.indexOf(to) + to.length;
    return src.slice(expandToBlockStart(d, f, t), t);
  };
  it('selection starting after hidden heading/list/quote markers carries them', () => {
    expect(at('# Title\n\npara\n', 'Title', 'para')).toBe('# Title\n\npara');
    expect(at('# Title\n', 'Title', 'Title')).toBe('# Title');
    expect(at('- one\n- two\n', 'one', 'two')).toBe('- one\n- two');
    expect(at('> q\n> r\n', 'q', 'r')).toBe('> q\n> r');
  });
  it('partial selections stay exact', () => {
    expect(at('# Title\n', 'itl', 'itl')).toBe('itl');
    expect(at('# Title\n', 'Tit', 'Tit')).toBe('Tit');
    expect(at('- one\n- two\n', 'one', 'one')).toBe('one');
    expect(at('para one\n\nx\n', 'one', 'x')).toBe('one\n\nx');
  });
});

describe('RTFD data: images on paste (#114)', () => {
  const PNG = 'iVBORw0KGgo='; // truncated bytes are fine: the helper never decodes for the fallback
  it('extractDataImages tokenizes imgs and keeps non-data imgs', () => {
    const r = extractDataImages(`<p>pic <img alt="shot.png" src="data:image/png;base64,${PNG}"> and <img src="https://x/y.png"></p>`);
    expect(r.imgs).toEqual([{ alt: 'shot.png', mime: 'image/png', b64: PNG }]);
    expect(r.html).toContain('\u20630\u2063');
    expect(r.html).toContain('https://x/y.png');
  });
  it('storeDataImages routes through the image rule and splices back into converted markdown', async () => {
    const r = extractDataImages(`<p>before <img alt="shot.png" src="data:image/png;base64,${PNG}"> after</p>`);
    const ed = { settings: { storeImage: async (i: { mime: string; name: string }) => `![kept](img/${i.name})` } } as unknown as EditorCore;
    const md = htmlToMarkdown(r.html);
    const snips = await storeDataImages(ed, r.imgs);
    const out = md.replace(/\u2063(\d+)\u2063/g, (_, i) => snips[+i] ?? '');
    expect(out).toBe('before ![kept](img/shot.png) after');
  });
  it('without the image rule the data: URI stays inline', async () => {
    const snips = await storeDataImages({ settings: {} } as unknown as EditorCore, [{ alt: 'a', mime: 'image/png', b64: PNG }]);
    expect(snips[0]).toBe(`![a](data:image/png;base64,${PNG})`);
  });
});
