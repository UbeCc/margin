/**
 * Remap Unicode Punctuation on Parse (#133, fe-preferences §10 + editor-core §290):
 * `〉》` blockquotes, `【x】`/`【 】` tasks, full-width heading/list markers, `–—`
 * thematic breaks, curly link-title quotes — recognition only, the source stays
 * byte-identical (lossless round-trip in both option states).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { parseBlocks, serializeLeaves } from './block';
import { parseInline, inlineSource } from './inline';
import { setSyntaxOptions, resetSyntaxOptions } from './options';
import type { ItemContainer, ParsedLeaf } from '../types';

const types = (s: string) => parseBlocks(s).map((l: ParsedLeaf) => l.type);
const chain0 = (s: string) => parseBlocks(s)[0]?.chain[0];
const rt = (s: string) => expect(serializeLeaves(parseBlocks(s))).toBe(s);

const REMAP_DOCS = [
  '〉quote\n〉more\n',
  '》bq\n》》nested\n',
  '＃ Heading\n＃＃ deep\n',
  '－ dash list\n＋ plus\n＊ star\n',
  '１． first\n２． second\n',
  '３) paren\n',
  '- 【 】 todo\n- 【x】 done\n- 【X】 upper\n',
  '———\n',
  '– – –\n',
  '【toc】\n\n# A\n',
  '[a](http://x “curly title”) and [b](http://y ’single’)\n',
  '》 mixed > ascii\n〉- 【x】 task in remapped quote\n',
  '－ a\n  － nested under ascii indent\n',
];

afterEach(resetSyntaxOptions);

describe('remap off (default): unicode punctuation is plain text', () => {
  it('〉 does not open a quote; 【x】 is not a task; ＃ is not a heading', () => {
    expect(chain0('〉quote\n')).toBeUndefined();
    expect(chain0('- 【x】 done\n')?.kind).toBe('item');
    expect((chain0('- 【x】 done\n') as ItemContainer).task).toBeNull();
    expect(types('＃ Heading\n')).toEqual(['paragraph']);
    expect(types('———\n')).toEqual(['paragraph']);
  });

  it('every remap doc round-trips losslessly without remap too', () => {
    for (const doc of REMAP_DOCS) rt(doc);
  });
});

describe('remap on (#133)', () => {
  beforeEach(() => setSyntaxOptions({ remapPunctuation: true }));

  it('〉 and 》 open blockquotes like > (prefix keeps the original char)', () => {
    const ls = parseBlocks('〉quote\n〉more\nlazy\n');
    expect(chain0('〉quote\n')?.kind).toBe('quote');
    expect(chain0('》bq\n》》nested\n')?.kind).toBe('quote');
    expect(ls[0].lines[0].prefix).toBe('〉');
    rt('〉quote\n〉more\nlazy\n');
  });

  it('full-width ＃ headings keep level and source', () => {
    const ls = parseBlocks('＃ Heading\n＃＃ deep\n');
    expect(ls.map((l) => l.type)).toEqual(['heading', 'heading']);
    expect(ls.map((l) => l.level)).toEqual([1, 2]);
    rt('＃ Heading\n＃＃ deep\n');
  });

  it('full-width list markers and ordered digits parse as lists', () => {
    expect(chain0('－ a\n')?.kind).toBe('item');
    expect(chain0('＋ b\n')?.kind).toBe('item');
    expect(chain0('＊ c\n')?.kind).toBe('item');
    const ol = parseBlocks('１．first\n２．second\n');
    expect(ol[0].chain[0]).toMatchObject({ ordered: true, start: 1 });
    expect((ol[0].chain[0] as ItemContainer).number).toBe(2 - 1);
    rt('－ a\n＋ b\n＊ c\n１．first\n２．second\n３) paren\n');
  });

  it('【x】/【 】 are task checkboxes', () => {
    const ls = parseBlocks('- 【 】 todo\n- 【x】 done\n- 【X】 upper\n');
    expect(ls.map((l) => (l.chain[0] as ItemContainer).task)).toEqual([' ', 'x', 'X']);
    rt('- 【 】 todo\n- 【x】 done\n');
  });

  it('– and — runs are thematic breaks', () => {
    expect(types('———\n')).toEqual(['hr']);
    expect(types('– – –\n')).toEqual(['hr']);
    rt('———\n– – –\n');
  });

  it('【toc】 is recognised even without remap', () => {
    resetSyntaxOptions();
    expect(types('【toc】\n')).toEqual(['toc']);
  });

  it('curly quotes delimit link titles (inline, lossless)', () => {
    const src = '[a](http://x “curly title”) and [b](http://y ’single’)';
    const n = parseInline(src, new Map());
    expect(inlineSource(n)).toBe(src);
    const link = n.find((x) => x.k === 'wrap') as { k: 'wrap'; title?: string };
    expect(link.title).toBe('curly title');
  });

  it('curly titles stay plain text when remap is off', () => {
    resetSyntaxOptions();
    expect(parseInline('[a](http://x “t”)', new Map()).some((x) => x.k === 'wrap')).toBe(false);
  });

  it('forced on by Convert-on-Input smart quotes/dashes', () => {
    resetSyntaxOptions();
    setSyntaxOptions({ smartPunctuation: 'input', smartQuote: true, remapPunctuation: false });
    expect(chain0('〉q\n')?.kind).toBe('quote');
    resetSyntaxOptions();
    setSyntaxOptions({ smartPunctuation: 'rendering', smartQuote: true, remapPunctuation: false });
    expect(chain0('〉q\n')).toBeUndefined();
  });

  it('every remap doc round-trips losslessly', () => {
    for (const doc of REMAP_DOCS) rt(doc);
  });
});
