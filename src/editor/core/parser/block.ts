/**
 * Line-based block parser (CommonMark + GFM subset, Typora extensions).
 * Produces a flat list of leaves; every input line is assigned verbatim to one
 * leaf, so `serialize(parseBlocks(x)) === x` holds by construction.
 */
import type { Container, ItemContainer, Line, ParsedLeaf } from '../types';
import { splitLines, isBlank, indentCols, consumeCols, columnOf, RawLine } from './lines';
import {
  atxLevel, fenceOpen, isFenceClose, mathOpen, isMathClose, isThematic, setextLevel,
  htmlStart, htmlEnds, isToc, isFootnoteDef, isLinkDef, quoteStart, listStart, isTableStart, isDashFence, FenceOpen,
} from './starts';

type Kind = 'para' | 'fence' | 'math' | 'html' | 'indented' | 'table';

interface Cur {
  leaf: ParsedLeaf;
  kind: Kind;
  fence?: FenceOpen;
  html?: number;
}

/** Can `s` interrupt a paragraph? */
export function interrupts(s: string, col = 0): boolean {
  if (indentCols(s, col) >= 4) return false;
  if (atxLevel(s) || fenceOpen(s) || mathOpen(s) || isThematic(s) || quoteStart(s)) return true;
  const h = htmlStart(s);
  if (h >= 1 && h <= 6) return true;
  const ls = listStart(s, col);
  return !!ls && !ls.empty && (!ls.ordered || ls.start === 1);
}

const isBlankLeaf = (l: ParsedLeaf) => l.type === 'paragraph' && l.n === 1 && isBlank(l.lines[0].text);

/** `keyBase` offsets container keys (local re-parse of a window must not reuse keys). */
export function parseBlocks(src: string, keyBase = 0): ParsedLeaf[] {
  const raw = splitLines(src);
  const leaves: ParsedLeaf[] = [];
  const open: Container[] = [];
  const lastItem: (ItemContainer | null)[] = [];
  const lastParent: number[] = [];
  let key = keyBase;
  let cur: Cur | null = null;
  let last: ParsedLeaf | null = null;
  let start = 0;

  const add = (leaf: ParsedLeaf) => {
    leaves.push(leaf);
    last = leaf;
    return leaf;
  };
  const push = (leaf: ParsedLeaf, line: Line) => {
    leaf.lines.push(line);
    leaf.n = leaf.lines.length;
  };

  // Front matter: `---` on the very first line, closed by `---` or `...`. #133 remap:
  // the `---`-line checks take the dash family (`—`, `–-`, `-–` via –→-- / —→--- equality).
  if (raw.length > 1 && isDashFence(raw[0].text)) {
    const end = raw.findIndex((l, i) => i > 0 && (isDashFence(l.text) || /^\.\.\.[ \t]*$/.test(l.text)));
    if (end > 0) {
      const lines = raw.slice(0, end + 1).map((l) => ({ prefix: '', text: l.text, eol: l.eol }));
      add({ type: 'front_matter', lines, n: lines.length, chain: [], openFrom: 0 });
      start = end + 1;
    }
  }

  for (let li = start; li < raw.length; li++) {
    const L: RawLine = raw[li];
    const t = L.text;
    let pos = 0;
    let matched = 0;
    for (; matched < open.length; matched++) {
      const c = open[matched];
      const rest = t.slice(pos);
      const col = columnOf(t, pos);
      if (c.kind === 'quote') {
        const q = quoteStart(rest);
        if (!q) break;
        pos += q;
      } else if (isBlank(rest)) {
        pos += consumeCols(rest, c.width, col);
      } else if (indentCols(rest, col) >= c.width) {
        pos += consumeCols(rest, c.width, col);
      } else break;
    }
    let rest = t.slice(pos);
    const all = matched === open.length;
    const line = (): Line => ({ prefix: t.slice(0, pos), text: t.slice(pos), eol: L.eol });

    // ---- continue an open leaf
    if (cur) {
      const c: Cur = cur;
      if (c.kind === 'fence' || c.kind === 'math' || (c.kind === 'html' && c.html! <= 5)) {
        if (all) {
          push(c.leaf, line());
          if (c.kind === 'fence' ? isFenceClose(rest, c.fence!) : c.kind === 'math' ? isMathClose(rest) : htmlEnds(c.html!, rest))
            cur = null;
          continue;
        }
        cur = null;
      } else if (c.kind === 'html') {
        if (all && !isBlank(rest)) { push(c.leaf, line()); continue; }
        cur = null;
      } else if (c.kind === 'indented') {
        if (all && !isBlank(rest) && indentCols(rest, columnOf(t, pos)) >= 4) { push(c.leaf, line()); continue; }
        cur = null;
      } else if (c.kind === 'table') {
        if (all && !isBlank(rest) && !interrupts(rest, columnOf(t, pos))) { push(c.leaf, line()); continue; }
        cur = null;
      } else {
        // paragraph-like
        const col = columnOf(t, pos);
        if (!isBlank(rest)) {
          if (all && c.leaf.type === 'paragraph') {
            const lv = setextLevel(rest);
            if (lv) {
              push(c.leaf, line());
              c.leaf.type = 'heading';
              c.leaf.level = lv;
              c.leaf.setext = true;
              cur = null;
              continue;
            }
            if (c.leaf.n === 1 && isTableStart(c.leaf.lines[0].text, rest)) {
              push(c.leaf, line());
              c.leaf.type = 'table';
              c.kind = 'table';
              continue;
            }
          }
          const newDef = c.leaf.type !== 'paragraph' && (isLinkDef(rest) || isFootnoteDef(rest));
          const ls = all ? null : listStart(rest, col);
          const oi = open[matched];
          // A sibling item of an open list may be empty / any number (only the first item of a list is restricted).
          const sib = !!ls && oi?.kind === 'item' && oi.ordered === ls.ordered && oi.delim === ls.delim;
          const lazyOk = all || (c.leaf.type === 'paragraph' && !(ls && (!ls.empty || sib)));
          if (!interrupts(rest, col) && !newDef && lazyOk) {
            push(c.leaf, line());
            continue;
          }
        }
        cur = null;
      }
    }

    // ---- close unmatched containers, open new ones
    open.length = matched;
    lastItem.length = Math.min(lastItem.length, matched + 1);
    const openedFrom = open.length;
    for (;;) {
      rest = t.slice(pos);
      const col = columnOf(t, pos);
      if (indentCols(rest, col) >= 4) break;
      const q = quoteStart(rest);
      if (q) {
        lastItem[open.length] = null;
        open.push({ kind: 'quote', key: ++key });
        lastItem.length = open.length;
        pos += q;
        continue;
      }
      const ls = listStart(rest, col);
      if (!ls) break;
      const d = open.length;
      const parent = d ? open[d - 1].key : -1;
      const prev = lastItem[d];
      const same = !!prev && prev.ordered === ls.ordered && prev.delim === ls.delim && lastParent[d] === parent;
      const item: ItemContainer = {
        kind: 'item', key: ++key, ordered: ls.ordered, delim: ls.delim, start: ls.start,
        number: same ? prev!.number + 1 : ls.start, index: same ? prev!.index + 1 : 0,
        listKey: same ? prev!.listKey : ++key, task: ls.task, width: ls.width, markerText: ls.markerText,
      };
      open.push(item);
      lastItem[d] = item;
      lastParent[d] = parent;
      lastItem.length = d + 1;
      pos += ls.consumed;
      if (ls.empty) break;
    }
    rest = t.slice(pos);
    const mk = (type: ParsedLeaf['type']): ParsedLeaf => ({
      type, lines: [line()], n: 1, chain: open.slice(), openFrom: openedFrom,
    });

    // ---- blank line
    if (isBlank(rest)) {
      const lst = last as ParsedLeaf | null;
      if (open.length === openedFrom && lst && lst.lines.length === lst.n && !isBlankLeaf(lst)) {
        lst.lines.push(line());
      } else add(mk('paragraph'));
      continue;
    }

    // ---- new leaf
    lastItem[open.length] = null;
    lastItem.length = open.length + 1;
    const col = columnOf(t, pos);
    if (indentCols(rest, col) >= 4) {
      cur = { leaf: add(mk('indented_code')), kind: 'indented' };
      continue;
    }
    const lv = atxLevel(rest);
    if (lv) {
      const leaf = add(mk('heading'));
      leaf.level = lv;
      continue;
    }
    const f = fenceOpen(rest);
    if (f) {
      const leaf = add(mk('code_fence'));
      leaf.lang = f.lang;
      cur = { leaf, kind: 'fence', fence: f };
      continue;
    }
    const m = mathOpen(rest);
    if (m) {
      const leaf = add(mk('math_block'));
      if (m === 'open') cur = { leaf, kind: 'math' };
      continue;
    }
    const h = htmlStart(rest);
    if (h) {
      const leaf = add(mk('html_block'));
      const firstEnds = h <= 5 && htmlEnds(h, rest.replace(/^ {0,3}<(?:!--|\?|!\[CDATA\[|!)/, ''));
      if (!firstEnds) cur = { leaf, kind: 'html', html: h };
      continue;
    }
    if (isThematic(rest)) { add(mk('hr')); continue; }
    if (isToc(rest)) { add(mk('toc')); continue; }
    const type = isFootnoteDef(rest) ? 'footnote' : isLinkDef(rest) ? 'def' : 'paragraph';
    cur = { leaf: add(mk(type)), kind: 'para' };
  }
  return leaves;
}

export function serializeLeaves(leaves: readonly { lines: Line[] }[]): string {
  let s = '';
  for (const l of leaves) for (const ln of l.lines) s += ln.prefix + ln.text + ln.eol;
  return s;
}
