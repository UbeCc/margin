/**
 * Structural edits on the Doc (DOM-free, unit tested): Enter splitting and
 * markdown shortcuts, Backspace/Delete merging, list indent/outdent, task
 * toggling, widget removal. Each returns where the caret should go.
 */
import { Doc, contPrefix, leafContent, leafRaw } from './model';
import type { ItemContainer, Leaf, Line } from './types';
import { isTextType } from './types';
import { splitRow, isDelimRow } from './parser/starts';
import { splitBlockMeta } from './render-inline';

export type Caret = { pos: number } | { widget: string; at: 'start' | 'end' };

export const isTextLeaf = (l: Leaf) => isTextType(l.type) || l.type === 'hr';

const MARKER_RE = /(?:[-+*]|\d{1,9}[.)])(?:[ \t]+(?:\[[ xX]\](?:[ \t]+|$))?|$)$/;

function lineStartPos(doc: Doc, i: number): number[] {
  const out: number[] = [];
  let p = doc.start(i);
  for (const ln of doc.leaves[i].lines) {
    out.push(p);
    p += ln.prefix.length + ln.text.length + ln.eol.length;
  }
  return out;
}

const raw = (lines: Line[]) => lines.map((l) => l.prefix + l.text + l.eol).join('');

/** Position of content offset `off` inside freshly built `lines` starting at `base`. */
function posIn(lines: Line[], base: number, off: number): number {
  let p = base;
  for (const ln of lines) {
    if (off <= ln.text.length) return p + ln.prefix.length + off;
    off -= ln.text.length + 1;
    p += ln.prefix.length + ln.text.length + ln.eol.length;
  }
  return p;
}

function replaceLeaf(doc: Doc, i: number, lines: Line[], off: number): Caret {
  const s = doc.start(i);
  doc.replace(s, s + leafRaw(doc.leaves[i]).length, raw(lines));
  return { pos: posIn(lines, s, off) };
}

function widgetCaret(doc: Doc, pos: number, at: 'start' | 'end'): Caret {
  const { i } = doc.locate(pos);
  const l = doc.leaves[i];
  return l && !isTextLeaf(l) ? { widget: l.id, at } : { pos };
}

/** Enter (or Shift+Enter) at content offset `off` of text leaf `i`. */
export function enter(doc: Doc, i: number, off: number, soft = false): Caret {
  const l = doc.leaves[i];
  const c = leafContent(l);
  const E = doc.eol;
  const p = contPrefix(l.chain);
  if (soft && l.type !== 'heading' && l.type !== 'hr') {
    doc.setContent(i, c.slice(0, off) + '\n' + c.slice(off));
    return { pos: doc.docPos(i, off + 1) };
  }
  const before = c.slice(0, off);
  const after = c.slice(off);
  if (!c.includes('\n') && l.type === 'paragraph') {
    const s = doc.docPos(i, 0);
    const to = doc.docPos(i, c.length);
    let rep: string | null = null;
    const f = /^( {0,3})(`{3,}|~{3,})([^`]*)$/.exec(before);
    if (f && !(f[2][0] === '`' && f[3].includes('`'))) rep = before + E + p + after + E + p + f[1] + f[2];
    else if (/^ {0,3}\$\$[ \t]*$/.test(before)) rep = before + E + p + after + E + p + '$$';
    else if (!after && /^ {0,3}\|.*\|[ \t]*$/.test(c) && !isDelimRow(c)) {
      const n = Math.max(1, splitRow(c).length);
      rep = c + E + p + '|' + ' --- |'.repeat(n) + E + p + '|' + '   |'.repeat(n);
    }
    if (rep !== null) {
      doc.replace(s, to, rep);
      return widgetCaret(doc, s, 'start');
    }
  }
  const inner = l.chain[l.chain.length - 1];
  if (inner && !c.trim() && isTextType(l.type)) return exitContainer(doc, i);
  const pos = doc.docPos(i, off);
  if (inner?.kind === 'item' && l.type !== 'indented_code') {
    let mk = inner.ordered ? `${inner.number + 1}${inner.delim} ` : `${inner.delim} `;
    if (inner.task !== null) mk += '[ ] ';
    const ins = E + contPrefix(l.chain.slice(0, -1)) + mk;
    doc.replace(pos, pos, ins);
    return { pos: pos + ins.length };
  }
  if (l.type === 'indented_code') {
    const line = c.slice(0, off).split('\n').pop()!;
    const ins = E + p + /^[ \t]*/.exec(line)![0];
    doc.replace(pos, pos, ins);
    return { pos: pos + ins.length };
  }
  const ins = E + contPrefix(l.chain, true) + E + p;
  if (l.type === 'hr') {
    const end = doc.docPos(i, c.length);
    doc.replace(end, end, ins);
    return { pos: end + ins.length };
  }
  doc.replace(pos, pos, ins);
  return { pos: pos + ins.length };
}

/** Enter on an empty item/quote line: outdent a nested item, else leave the container as an empty paragraph. */
function exitContainer(doc: Doc, i: number): Caret {
  const l = doc.leaves[i];
  const outerItem = l.chain.slice(0, -1).some((x) => x.kind === 'item');
  if (l.chain[l.chain.length - 1].kind === 'item' && outerItem) return indent(doc, i, 0, true)!;
  const E = doc.eol;
  const outer = l.chain.slice(0, -1);
  const prev = doc.leaves[i - 1];
  const sep = prev && prev.lines.length === prev.n ? contPrefix(outer, true) + E : '';
  const last = l.lines[l.n - 1];
  const trail = l.lines.slice(l.n).map((x) => x.prefix + x.text + x.eol).join('');
  const rep = sep + contPrefix(outer) + (last.eol || (i + 1 < doc.leaves.length ? E : '')) + trail;
  const s = doc.start(i);
  doc.replace(s, s + leafRaw(l).length, rep);
  return { pos: s + sep.length + contPrefix(outer).length };
}

/** Strip the innermost container's syntax from every line of leaf `i`. */
export function dropContainer(doc: Doc, i: number, off: number): Caret {
  const l = doc.leaves[i];
  const inner = l.chain[l.chain.length - 1];
  if (!inner) return { pos: doc.docPos(i, off) };
  const opened = l.openFrom <= l.chain.length - 1;
  const lines = l.lines.map((ln, k) => {
    let prefix = ln.prefix;
    if (inner.kind === 'quote') prefix = prefix.replace(/ {0,3}>[ \t]?$/, '');
    else if (k === 0 && opened) prefix = prefix.replace(MARKER_RE, '').replace(/ {0,3}$/, '');
    else prefix = prefix.replace(new RegExp(` {0,${inner.width}}$`), '');
    return { ...ln, prefix };
  });
  return replaceLeaf(doc, i, lines, off);
}

/** Backspace at content offset `off` with a collapsed caret. Null = let the browser handle it. */
export function backspace(doc: Doc, i: number, off: number): Caret | null {
  const l = doc.leaves[i];
  const c = leafContent(l);
  if (l.type === 'heading' && !l.setext) {
    const pre = splitBlockMeta(l, c)[0];
    if (pre && off === pre.length) {
      doc.setContent(i, c.slice(pre.length));
      return { pos: doc.docPos(i, 0) };
    }
  }
  if (off !== 0) return null;
  if (l.chain.length && l.openFrom < l.chain.length) return dropContainer(doc, i, 0);
  if (i === 0) return l.type === 'heading' ? null : { pos: 0 };
  const prev = doc.leaves[i - 1];
  if (prev.type === 'hr') {
    doc.replace(doc.start(i - 1), doc.start(i), '');
    return { pos: doc.docPos(i - 1, 0) };
  }
  if (!isTextLeaf(prev)) {
    if (!c && l.lines.length === 1 && i === doc.leaves.length - 1) {
      // keep the trailing empty paragraph (caret target after the widget)
    } else if (!c) doc.replace(doc.start(i), doc.start(i + 1), '');
    return { widget: prev.id, at: 'end' };
  }
  const from = doc.docPos(i - 1, leafContent(prev).length);
  doc.replace(from, doc.docPos(i, 0), '');
  return { pos: from };
}

/** Delete at the end of text leaf `i`. Null = let the browser handle it. */
export function del(doc: Doc, i: number, off: number): Caret | null {
  const l = doc.leaves[i];
  const c = leafContent(l);
  if (off !== c.length) return null;
  const next = doc.leaves[i + 1];
  if (!next) return { pos: doc.docPos(i, off) };
  if (next.type === 'hr') {
    doc.replace(doc.start(i + 1), doc.start(i + 2), '');
    return { pos: doc.docPos(i, off) };
  }
  if (!isTextLeaf(next)) {
    if (!c) {
      const id = next.id;
      doc.replace(doc.start(i), doc.start(i + 1), '');
      return { widget: id, at: 'start' };
    }
    return { widget: next.id, at: 'start' };
  }
  const from = doc.docPos(i, c.length);
  doc.replace(from, doc.docPos(i + 1, 0), '');
  return { pos: from };
}

/** Tab / Shift+Tab inside a list item. Null when leaf `i` is not a list item. */
export function indent(doc: Doc, i: number, off: number, out: boolean): Caret | null {
  const l = doc.leaves[i];
  const items = l.chain.filter((x): x is ItemContainer => x.kind === 'item');
  const item = items[items.length - 1];
  if (!item || l.chain[l.chain.length - 1] !== item) return null;
  const opened = l.openFrom <= l.chain.length - 1;
  if (out) {
    const parent = items[items.length - 2];
    if (!parent) return dropContainer(doc, i, off);
    const lines = l.lines.map((ln, k) => {
      const cut = k === 0 && opened ? ln.prefix.search(MARKER_RE) : ln.prefix.length - item.width;
      if (cut < 0) return ln;
      const before = ln.prefix.slice(0, cut);
      const m = new RegExp(` {1,${parent.width}}$`).exec(before);
      return m ? { ...ln, prefix: before.slice(0, m.index) + ln.prefix.slice(cut) } : ln;
    });
    return replaceLeaf(doc, i, lines, off);
  }
  if (item.index === 0 || !opened) return { pos: doc.docPos(i, off) };
  const pad = ' '.repeat(item.width);
  const lines = l.lines.map((ln, k) => {
    const cut = k === 0 ? ln.prefix.search(MARKER_RE) : ln.prefix.length - item.width;
    if (cut < 0 || (k >= l.n && !ln.text)) return ln;
    return { ...ln, prefix: ln.prefix.slice(0, cut) + pad + ln.prefix.slice(cut) };
  });
  return replaceLeaf(doc, i, lines, off);
}

/** Toggle the task checkbox shown on leaf `i`. */
export function toggleTask(doc: Doc, i: number): boolean {
  const l = doc.leaves[i];
  const pre = l.lines[0].prefix;
  const m = /\[([ xX])\][ \t]*$/.exec(pre);
  if (!m) return false;
  const at = lineStartPos(doc, i)[0] + m.index + 1;
  doc.replace(at, at + 1, m[1] === ' ' ? 'x' : ' ');
  return true;
}

/** Turn widget leaf `i` into an empty paragraph (keeps container prefixes). */
export function widgetToParagraph(doc: Doc, i: number): Caret {
  const l = doc.leaves[i];
  const s = doc.start(i);
  const last = i === doc.leaves.length - 1;
  const eol = last && !l.lines[l.lines.length - 1].eol ? '' : doc.eol;
  const pfx = l.lines[0].prefix;
  const trail = l.lines.slice(l.n).map((x) => x.prefix + x.text + x.eol).join('');
  doc.replace(s, s + leafRaw(l).length, pfx + eol + trail);
  return { pos: s + pfx.length };
}

/** Ensure there is a text leaf after widget/hr leaf `i` (for caret exit down). */
export function ensureParagraphAfter(doc: Doc, i: number): Caret {
  const next = doc.leaves[i + 1];
  if (next && isTextLeaf(next)) return { pos: doc.docPos(i + 1, 0) };
  if (next) return { widget: next.id, at: 'start' };
  const n = doc.leaves.length;
  for (let k = 0; k < 3 && doc.leaves.length === n; k++) {
    const end = doc.start(doc.leaves.length);
    doc.replace(end, end, doc.eol);
  }
  return { pos: doc.start(doc.leaves.length - 1) };
}
