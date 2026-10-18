/** Read-only document queries: outline, CJK-aware stats, find. */
import type { EditorStats, Heading } from '../../contracts';
import { Doc, leafContent } from './model';
import { parseInline, inlinePlain } from './parser/inline';
import { headingText, splitBlockMeta } from './render-inline';

export function outline(doc: Doc): Heading[] {
  const refs = doc.refs();
  const out: Heading[] = [];
  for (const l of doc.leaves) {
    if (l.type !== 'heading') continue;
    out.push({ id: l.id, level: (l.level ?? 1) as Heading['level'], text: headingText(l, leafContent(l), refs) });
  }
  return out;
}

/** Plain text of the document (markers removed, widgets as raw-ish text). */
export function plainText(doc: Doc): string {
  const refs = doc.refs();
  const parts: string[] = [];
  for (const l of doc.leaves) {
    const c = leafContent(l);
    if (l.type === 'paragraph' || l.type === 'heading' || l.type === 'footnote')
      parts.push(inlinePlain(parseInline(splitBlockMeta(l, c)[1], refs)));
    else if (l.type === 'code_fence' || l.type === 'math_block') parts.push(l.lines.slice(1, l.n - 1).map((x) => x.text).join('\n'));
    else if (l.type === 'indented_code' || l.type === 'table') parts.push(c.replace(/[|:-]{3,}|\|/g, ' '));
  }
  return parts.join('\n');
}

const CJK = /[⺀-⿿぀-ヿ㄀-ㇿ㐀-䶿一-鿿가-힯豈-﫿ｦ-ﾟ]|[\u{20000}-\u{2FA1F}]/u;

/** Words: each CJK character counts as one word, other runs of letters/digits as one. */
export function countStats(text: string, md: string): EditorStats {
  let words = 0;
  let inWord = false;
  let characters = 0;
  for (const ch of text) {
    if (!/\s/.test(ch)) characters++;
    if (CJK.test(ch)) {
      words++;
      inWord = false;
    } else if (/[\p{L}\p{N}_'’-]/u.test(ch)) {
      if (!inWord) words++;
      inWord = true;
    } else inWord = false;
  }
  const lines = md ? md.split(/\r\n|\r|\n/).length - (/(\r\n|\r|\n)$/.test(md) ? 1 : 0) : 0;
  return { words, characters, lines };
}

/** Next match of `q` in `text` relative to `[selFrom, selTo]`; wraps around. */
export function findIn(text: string, q: string, selFrom: number, selTo: number, caseSensitive = false, backwards = false): number {
  if (!q) return -1;
  const h = caseSensitive ? text : text.toLowerCase();
  const n = caseSensitive ? q : q.toLowerCase();
  if (!backwards) {
    let i = h.indexOf(n, selFrom === selTo ? selFrom : selFrom + 1);
    if (i < 0) i = h.indexOf(n);
    return i;
  }
  let i = selFrom > 0 ? h.lastIndexOf(n, selFrom - 1) : -1;
  if (i < 0) i = h.lastIndexOf(n);
  return i;
}

/** Find options (#96): Match Case, Whole Word, Regular Expression. */
export interface FindOptions {
  caseSensitive?: boolean;
  wholeWord?: boolean;
  regex?: boolean;
}

/** Global regex for `q` under `o`, or null when `q` is empty or an invalid pattern. */
export function compileQuery(q: string, o: FindOptions = {}): RegExp | null {
  if (!q) return null;
  let src = o.regex ? q : q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  if (o.wholeWord) src = `(?<![\\p{L}\\p{N}_])(?:${src})(?![\\p{L}\\p{N}_])`;
  try {
    return new RegExp(src, 'gu' + (o.caseSensitive ? '' : 'i') + (o.regex ? 'm' : ''));
  } catch {
    return null;
  }
}

/** Every non-empty match of `re` in `text`. */
export function allMatches(text: string, re: RegExp): { index: number; length: number; match: RegExpExecArray }[] {
  const out: { index: number; length: number; match: RegExpExecArray }[] = [];
  re.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    if (!m[0].length) {
      re.lastIndex++;
      continue;
    }
    out.push({ index: m.index, length: m[0].length, match: m });
  }
  return out;
}

/** Next match relative to the selection `[selFrom, selTo]` (wraps around), or null. */
export function findMatch(text: string, q: string, selFrom: number, selTo: number, o: FindOptions = {}, backwards = false): { index: number; length: number } | null {
  const re = compileQuery(q, o);
  if (!re) return null;
  const ms = allMatches(text, re);
  if (!ms.length) return null;
  if (!backwards) {
    const start = selFrom === selTo ? selFrom : selFrom + 1;
    return ms.find((m) => m.index >= start) ?? ms[0];
  }
  for (let k = ms.length - 1; k >= 0; k--) if (ms[k].index < selFrom) return ms[k];
  return ms[ms.length - 1];
}
