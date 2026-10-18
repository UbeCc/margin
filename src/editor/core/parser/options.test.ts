import { describe, it, expect, afterEach } from 'vitest';
import { parseInline, inlineSource, type INode } from './inline';
import { atxLevel } from './starts';
import { setSyntaxOptions, resetSyntaxOptions, syntaxOptions } from './options';
import { DEFAULT_MARKDOWN_OPTIONS, type MarkdownOptions } from '../../../contracts';
import { parseBlocks, serializeLeaves } from './block';

const tags = (ns: INode[]): string[] =>
  ns.flatMap((n) => (n.k === 'wrap' ? [n.tag, ...tags(n.ch)] : n.k === 'entity' ? ['entity:' + n.ch] : n.k === 'math' ? ['math'] : n.k === 'br' ? ['br'] : []));

const CASES = [
  'H~2~O and X^2^ and ==mark== and ~~del~~', 'a ^b c^ d', 'x^y', ':smile: :nope: :+1:', '$x$ and \\$y$', 'back\\\nslash',
  '~a~b~', '^^x^^', '==a', '#Heading', '#tag line', '##No space ##', '#', '#1', 'a :smile:: b', '~~', '^', ':',
];

const ALL: Partial<MarkdownOptions>[] = [
  {},
  { subscript: true, superscript: true, emoji: true },
  { highlight: false, inlineMath: false, strict: false },
  { subscript: true, superscript: true, emoji: true, highlight: false, inlineMath: false, strict: false },
];

afterEach(() => resetSyntaxOptions());

describe('syntax options (#102)', () => {
  it('defaults match the contract', () => expect(syntaxOptions).toEqual(DEFAULT_MARKDOWN_OPTIONS));

  for (const [k, o] of ALL.entries())
    it(`lossless round-trip under option set ${k}`, () => {
      setSyntaxOptions(o);
      for (const c of CASES) expect(inlineSource(parseInline(c))).toBe(c);
      const doc = CASES.join('\n\n') + '\n\n# H\n\n#H2\n\n- a\n- b\n';
      expect(serializeLeaves(parseBlocks(doc))).toBe(doc);
    });

  it('subscript / superscript toggles', () => {
    expect(tags(parseInline('H~2~O X^2^'))).toEqual(['del']);
    setSyntaxOptions({ subscript: true, superscript: true });
    expect(tags(parseInline('H~2~O X^2^'))).toEqual(['sub', 'sup']);
    expect(tags(parseInline('~~gone~~'))).toEqual(['del']);
    expect(tags(parseInline('a ^ b ^ c'))).toEqual([]);
  });

  it('highlight and inline math can be turned off', () => {
    expect(tags(parseInline('==k== $x$'))).toEqual(['mark', 'math']);
    setSyntaxOptions({ highlight: false, inlineMath: false });
    expect(tags(parseInline('==k== $x$'))).toEqual([]);
  });

  it('emoji shortcodes render only when enabled and known', () => {
    expect(tags(parseInline(':smile:'))).toEqual([]);
    setSyntaxOptions({ emoji: true });
    expect(tags(parseInline(':smile: :unknown_code:'))).toEqual(['entity:😄']);
  });

  it('strict mode requires a space after #', () => {
    expect(atxLevel('#Heading')).toBe(0);
    expect(atxLevel('## H')).toBe(2);
    setSyntaxOptions({ strict: false });
    expect(atxLevel('#Heading')).toBe(1);
    expect(atxLevel('####### x')).toBe(0);
    expect(atxLevel('#')).toBe(1);
  });

  it('setSyntaxOptions reports parser-relevant changes only', () => {
    expect(setSyntaxOptions({ ulStyle: '*' })).toBe(false);
    expect(setSyntaxOptions({ emoji: true })).toBe(true);
    expect(setSyntaxOptions({ emoji: true })).toBe(false);
  });
});

describe('non-strict headings (#102)', () => {
  it('#Heading becomes a heading leaf only outside strict mode', () => {
    expect(parseBlocks('#Heading\n')[0].type).toBe('paragraph');
    setSyntaxOptions({ strict: false });
    const l = parseBlocks('#Heading\n')[0];
    expect([l.type, l.level]).toEqual(['heading', 1]);
  });
});

describe('option fuzz (#102)', () => {
  it('inline source is lossless for random input under every option set', () => {
    const atoms = ['~', '~~', '^', '==', '=', ':', ':smile:', '$', '\\', '\n', '#', ' ', 'a', '*', '_', '`', '[', ']', '(', ')'];
    let seed = 11;
    const rnd = (n: number) => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) % n);
    for (const o of ALL) {
      resetSyntaxOptions();
      setSyntaxOptions(o);
      for (let k = 0; k < 1500; k++) {
        let s = '';
        for (let i = rnd(24); i > 0; i--) s += atoms[rnd(atoms.length)];
        expect(inlineSource(parseInline(s))).toBe(s);
        expect(serializeLeaves(parseBlocks(s))).toBe(s);
      }
    }
  });
});
