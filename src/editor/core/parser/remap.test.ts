/**
 * Remap Unicode Punctuation on Parse (#133, fe-preferences §7.3/§10 + typora-re#12):
 * `〉》` blockquotes, `[\[【](x|X)[\]】]` task brackets, dash family (`–→--`, `—→---`
 * front-matter/`---`-line equality + dash-first mixed thematic runs), curly
 * link-title quotes. Full-width ＃/－＋＊/digits are INERT. Recognition only:
 * the source stays byte-identical (lossless round-trip in both option states).
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
  '＃ Heading\n＃＃ deep\n', // inert: paragraphs even with remap on
  '－ dash list\n＋ plus\n＊ star\n',
  '１． first\n２． second\n',
  '３) paren\n',
  '- 【 】 todo\n- 【x】 done\n- 【X】 upper\n- [x】 mixed\n',
  '—\n—-\n–—-\n––\n',
  '—\ntitle: x\n—\n–-\na: 1\n–-\n',
  'Title\n—\nSub\n–-\n',
  '【toc】\n\n# A\n',
  '[a](http://x “curly title”) and [b](http://y ’single’)\n',
  '》 mixed > ascii\n〉- 【x】 task in remapped quote\n',
  '- a\n  - nested under ascii indent\n',
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

  it('full-width ＃ / list markers / digits are inert (typora-re#12)', () => {
    // No block-start regex contains ＃, －＋＊, full-width digits or `．`:
    // `＃ Heading`, `－ a`, `１． first` are paragraphs in every configuration.
    expect(types('＃ Heading\n\n＃＃ deep\n')).toEqual(['paragraph', 'paragraph']);
    expect(chain0('－ a\n')?.kind).not.toBe('item');
    expect(chain0('＋ b\n')?.kind).not.toBe('item');
    expect(chain0('＊ c\n')?.kind).not.toBe('item');
    expect(chain0('１． first\n')?.kind).not.toBe('item');
    expect(chain0('－－－\n')?.kind).not.toBe('item'); // full-width minus － never remaps
    rt('＃ Heading\n－ a\n＋ b\n＊ c\n１． first\n２． second\n３) paren\n');
  });

  it('【x】/【 】 are task checkboxes (mixed brackets too)', () => {
    const ls = parseBlocks('- 【 】 todo\n- 【x】 done\n- 【X】 upper\n- [x】 mixed\n- 【X] mixed\n');
    expect(ls.map((l) => (l.chain[0] as ItemContainer).task)).toEqual([' ', 'x', 'X', 'x', 'X']);
    rt('- 【 】 todo\n- 【x】 done\n- [x】 mixed\n');
  });

  it('dash family: dash-first mixed runs are thematic breaks (V regex)', () => {
    expect(types('—\n')).toEqual(['hr']); // em dash alone → `---`
    expect(types('—-\n')).toEqual(['hr']);
    expect(types('–-\n')).toEqual(['hr']);
    expect(types('–—-\n')).toEqual(['hr']);
    expect(types('––\n')).toEqual(['hr']); // – needs one more dash char; –– qualifies
    expect(types('–\n')).toEqual(['paragraph']); // lone – is too short
    expect(types('– – –\n')).toEqual(['paragraph']); // V runs are spaceless
    expect(types('－-\n')).toEqual(['paragraph']); // full-width minus is inert
    rt('—\n—-\n–—-\n––\n');
  });

  it('dash family: front-matter fences via –→-- / —→--- equality', () => {
    expect(types('—\ntitle: x\n—\n')).toEqual(['front_matter']);
    expect(types('–-\ntitle: x\n–-\n')).toEqual(['front_matter']);
    expect(types('-–\ntitle: x\n-–\n')).toEqual(['front_matter']);
    expect(types('—-\ntitle: x\n—-\n')).toEqual(['hr', 'heading']); // `----` ≠ `---` for the fence, but V matches as break/underline
    expect(types('––\ntitle: x\n––\n')).toEqual(['hr', 'heading']); // `––` → `----` ≠ fence; V: –– qualifies
    expect(types('—\ntitle: x\n...\n')).toEqual(['front_matter']); // `...` still closes
    rt('—\ntitle: x\n—\n–-\na: 1\n–-\n');
  });

  it('dash family: setext underline takes mixed runs (dash-first)', () => {
    expect(types('Title\n—\n')).toEqual(['heading']);
    expect(parseBlocks('Title\n–-\n')[0].level).toBe(2);
    expect(types('Title\n–\n')).toEqual(['paragraph']); // lone – is not an underline (lazy continuation merges)
    expect(types('Title\n－\n')).toEqual(['paragraph']); // － is inert
    rt('Title\n—\nSub\n–-\n');
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
    const src = '[a](http://x “t”)';
    const n = parseInline(src, new Map());
    // Not a markdown link with a curly-quoted title; the bare URL still autolinks
    // (pre-existing behaviour, unrelated to remap), so check for a titled link only.
    expect(n.some((x) => x.k === 'wrap' && x.tag === 'link' && x.title === 't')).toBe(false);
    expect(inlineSource(n)).toBe(src);
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
