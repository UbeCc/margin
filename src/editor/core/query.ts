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
