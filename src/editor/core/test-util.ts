/** Test helpers shared by the property / fuzz tests (not used at runtime). */
import { Doc, leafContent } from './model';
import { parseBlocks } from './parser/block';
import { isTextLeaf } from './edit';
import type { Leaf, ParsedLeaf } from './types';

/** Deterministic PRNG (mulberry32). */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const CHAIN = (l: ParsedLeaf) =>
  l.chain.map((c) => (c.kind === 'quote' ? 'q' : `i${c.ordered ? c.number + c.delim : c.delim}${c.task ?? ''}w${c.width}#${c.index}`)).join(',') + '|' + l.openFrom;

/** Structural signature of a leaf list (no ids, no container keys). */
export function shape(ls: readonly ParsedLeaf[]): string[] {
  return ls.map((l) => [l.type, l.level ?? '', l.setext ? 's' : '', l.lang ?? '', CHAIN(l), l.n, JSON.stringify(l.lines)].join(' '));
}

const HOLD_TYPES = new Set(['hr', 'code_fence', 'math_block', 'html_block', 'front_matter', 'toc', 'def', 'footnote', 'table', 'diagram']);
const HOLD_RE = /^ {0,3}(?:#{1,6}|[-+*]|\d{1,9}[.)]|>)$/;

/**
 * Leaves the editor deliberately keeps unconverted while the caret is in them
 * (Typora converts on Enter / leaving the block): a lone `-`/`#`/`>` marker,
 * text that alone would start a fence/hr/table/html block, and a trailing
 * empty line created by Shift+Enter.
 */
function held(l: Leaf): boolean {
  if (!isTextLeaf(l)) return false;
  const c = leafContent(l);
  // An emptied block stays a caret target even where a parse would merge it.
  if (l.type === 'paragraph' && /^[ \t\n]*$/.test(c)) return true;
  if (HOLD_RE.test(c.split('\n')[0])) return true;
  for (const src of [c, l.lines[0].prefix + c]) {
    const alone = parseBlocks(src)[0];
    if (alone && HOLD_TYPES.has(alone.type) && alone.type !== l.type) return true;
  }
  return l.n > 1 && /^[ \t]*$/.test(l.lines[l.n - 1].text);
}

/**
 * Problems of the incremental model vs a fresh parse of its own text (after
 * settling held leaves), plus id / position-mapping consistency. [] = fine.
 */
export function modelProblems(d: Doc): string[] {
  const text = d.text();
  const want = shape(parseBlocks(text));
  if (d.leaves.some(held) && shape(d.leaves).join('\n') !== want.join('\n')) d.reparse(text);
  const got = shape(d.leaves);
  const out: string[] = [];
  if (got.join('\n') !== want.join('\n')) out.push(`model:\n  ${got.join('\n  ')}\nparse:\n  ${want.join('\n  ')}`);
  if (new Set(d.leaves.map((l) => l.id)).size !== d.leaves.length) out.push('duplicate ids');
  d.leaves.forEach((l, i) => {
    if (d.indexOf(l.id) !== i) out.push(`indexOf(${l.id}) != ${i}`);
    if (!isTextLeaf(l)) return;
    const c = leafContent(l);
    for (const off of [0, c.length >> 1, c.length]) {
      const r = d.locate(d.docPos(i, off));
      if (r.i !== i || r.off !== off) out.push(`locate(docPos(${i},${off})) = ${JSON.stringify(r)}`);
    }
  });
  return out;
}

