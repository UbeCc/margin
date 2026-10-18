/**
 * Edit › Selection / Delete scopes and Jump To (#96).
 *
 * Scopes are computed on a text leaf's content (its markdown source with the
 * container prefixes stripped, lines joined by '\n'):
 *  - word      the word under the caret (markers like `**` are not word chars)
 *  - line      the sentence containing the caret, never crossing a line break
 *  - block     the whole block (hidden block markers excluded when selecting);
 *              repeated on a selected block it widens to the enclosing list
 *              item / quote
 *  - styled    the innermost inline styled run (`**…**`, `*…*`, `` `…` ``,
 *              `~~…~~`, `==…==`, `[…](…)`): select picks its text, delete
 *              removes it together with its markers
 *  - range     (delete only) the current selection
 */
import { scrollParent, type EditorCore } from './editor';
import { isTextLeaf, type Caret } from './edit';
import { leafContent } from './model';
import { splitBlockMeta } from './render-inline';
import { expandToBlockStart } from './clipboard';

export type SelectScope = 'word' | 'line' | 'block' | 'styled';
export type DeleteScope = SelectScope | 'range';
export type JumpTarget = 'top' | 'bottom' | 'selection';

type Span = [number, number];

const WORD = /[\p{L}\p{N}\p{M}_'’-]/u;

/** Word around content offset `off` (prefers the word before the caret at a boundary). */
export function wordRange(text: string, off: number): Span | null {
  const isW = (k: number) => k >= 0 && k < text.length && WORD.test(text[k]) && !(text[k] === '-' || text[k] === "'" || text[k] === '’') ;
  const inner = (k: number) => k >= 0 && k < text.length && WORD.test(text[k]);
  let at = off;
  if (!isW(at) && isW(at - 1)) at = off - 1;
  if (!isW(at)) return null;
  // CJK has no spaces: a run of ideographs is segmented with Intl when available
  const Seg = (Intl as unknown as { Segmenter?: new (l?: string, o?: { granularity: string }) => { segment(s: string): Iterable<{ segment: string; index: number; isWordLike?: boolean }> } }).Segmenter;
  let a = at;
  let b = at + 1;
  while (a > 0 && inner(a - 1)) a--;
  while (b < text.length && inner(b)) b++;
  // trim joiners at the edges
  while (a < b && !isW(a)) a++;
  while (b > a && !isW(b - 1)) b--;
  if (Seg && /[぀-ヿ㐀-鿿가-힯]/.test(text.slice(a, b))) {
    for (const s of new Seg(undefined, { granularity: 'word' }).segment(text.slice(a, b))) {
      const s0 = a + s.index;
      const s1 = s0 + s.segment.length;
      if (at >= s0 && at < s1) return [s0, s1];
    }
  }
  return a < b ? [a, b] : null;
}

/** Sentence containing `off`, bounded by the line (`\n`) it is on; trailing spaces excluded. */
export function sentenceRange(text: string, off: number): Span {
  const ls = text.lastIndexOf('\n', off - 1) + 1;
  let le = text.indexOf('\n', off);
  if (le < 0) le = text.length;
  const line = text.slice(ls, le);
  const rel = off - ls;
  // sentence ends after . ! ? 。 ！ ？ (plus closing quotes/brackets) followed by space or end
  const re = /[.!?。！？…]+["'”’)\]]*(?:\s+|$)|[。！？]+/g;
  let start = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(line))) {
    const end = m.index + m[0].length;
    if (end > rel || end === line.length) {
      return trimSpan(line, start, end, ls);
    }
    start = end;
    if (m[0].length === 0) re.lastIndex++;
  }
  return trimSpan(line, start, line.length, ls);
}

function trimSpan(line: string, a: number, b: number, base: number): Span {
  while (a < b && /\s/.test(line[a])) a++;
  while (b > a && /\s/.test(line[b - 1])) b--;
  return [base + a, base + b];
}

const STYLED: { re: RegExp; open: number; close: number | ((m: RegExpExecArray) => number) }[] = [
  { re: /\*\*(?=\S)([\s\S]*?\S)\*\*/g, open: 2, close: 2 },
  { re: /__(?=\S)([\s\S]*?\S)__/g, open: 2, close: 2 },
  { re: /~~(?=\S)([\s\S]*?\S)~~/g, open: 2, close: 2 },
  { re: /==(?=\S)([\s\S]*?\S)==/g, open: 2, close: 2 },
  { re: /(?<![*\\])\*(?![*\s])([^*\n]*?[^*\s])\*(?!\*)/g, open: 1, close: 1 },
  { re: /(?<![_\w\\])_(?![_\s])([^_\n]*?[^_\s])_(?![_\w])/g, open: 1, close: 1 },
  { re: /(`+)(?!`)([\s\S]*?[^`])\1(?!`)/g, open: -1, close: -1 },
  { re: /!?\[([^\]\n]*)\]\([^)\n]*\)/g, open: -1, close: -1 },
];

/** Innermost inline styled run containing `off`: inner = its text, outer = with markers. */
export function styledRange(text: string, off: number): { inner: Span; outer: Span } | null {
  let best: { inner: Span; outer: Span } | null = null;
  for (const { re, open } of STYLED) {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text))) {
      const o0 = m.index;
      const o1 = m.index + m[0].length;
      if (off < o0 || off > o1) continue;
      let i0: number;
      let i1: number;
      if (open > 0) {
        i0 = o0 + open;
        i1 = o1 - open;
      } else if (m[0].startsWith('`')) {
        i0 = o0 + m[1].length;
        i1 = o1 - m[1].length;
      } else {
        i0 = o0 + m[0].indexOf('[') + 1;
        i1 = i0 + m[1].length;
      }
      if (!best || o1 - o0 < best.outer[1] - best.outer[0]) best = { inner: [i0, i1], outer: [o0, o1] };
    }
  }
  return best;
}

// ------------------------------------------------------------- editor glue

interface Target {
  i: number;
  from: number;
  to: number;
}

/** Document range of a scope at the caret, or a widget id for block scope on a widget. */
function scopeAt(ed: EditorCore, scope: SelectScope, forDelete: boolean): Target | { widget: string; i: number } | null {
  const doc = ed.doc;
  if (!doc.leaves.length) return null;
  const s = ed.readSel() ?? ed.lastSel ?? { anchor: 0, focus: 0 };
  const sel = ed.sel();
  const { i, off } = doc.locate(s.focus);
  const l = doc.leaves[i];
  if (!l) return null;
  if (!isTextLeaf(l)) return scope === 'block' ? { widget: l.id, i } : null;
  const c = leafContent(l);
  const pos = (o: number) => doc.docPos(i, o);
  let span: Span | null = null;
  switch (scope) {
    case 'word':
      span = wordRange(c, off);
      break;
    case 'line':
      span = sentenceRange(c, off);
      break;
    case 'styled': {
      const r = styledRange(c, off);
      span = r ? (forDelete ? r.outer : r.inner) : null;
      break;
    }
    case 'block': {
      if (forDelete) return { i, from: doc.start(i), to: doc.start(i + 1) };
      const [pre, body] = splitBlockMeta(l, c);
      const a = pos(pre.length);
      const b = pos(pre.length + body.length);
      // already selected: widen to the enclosing container (list item / quote)
      if (sel.from <= a && sel.to >= b && l.chain.length) {
        const key = l.chain[l.chain.length - 1].key;
        let i0 = i;
        let i1 = i;
        const inC = (k: number) => doc.leaves[k]?.chain.some((x) => x.key === key);
        while (inC(i0 - 1)) i0--;
        while (inC(i1 + 1)) i1++;
        const last = doc.leaves[i1];
        const lc = isTextLeaf(last) ? leafContent(last).length : 0;
        return { i: i0, from: doc.docPos(i0, 0), to: doc.docPos(i1, lc) };
      }
      return { i, from: a, to: b };
    }
  }
  return span && span[1] > span[0] ? { i, from: pos(span[0]), to: pos(span[1]) } : null;
}

export function selectScope(ed: EditorCore, scope: SelectScope): boolean {
  const t = scopeAt(ed, scope, false);
  if (!t) return false;
  if ('widget' in t) {
    ed.setSel({ widget: t.widget, at: 'start' });
    return true;
  }
  ed.setSel({ anchor: t.from, focus: t.to });
  ed.emitSel();
  return true;
}

export function deleteScope(ed: EditorCore, scope: DeleteScope): boolean {
  const doc = ed.doc;
  if (scope === 'range') {
    const s = ed.readSel() ?? ed.lastSel;
    if (!s || s.anchor === s.focus) return false;
    const to = Math.max(s.anchor, s.focus);
    const from = expandToBlockStart(doc, Math.min(s.anchor, s.focus), to);
    ed.hist.break();
    ed.replaceRange(from, to, '', null);
    ed.hist.break();
    return true;
  }
  const t = scopeAt(ed, scope, true);
  if (!t) return false;
  const i = t.i;
  const from = 'widget' in t ? doc.start(i) : t.from;
  const to = 'widget' in t ? doc.start(i + 1) : t.to;
  ed.hist.break();
  if (scope === 'block' || 'widget' in t) {
    ed.change(() => {
      const text = doc.text();
      // keep the document's last newline state: removing the last block drops the separator before it
      const last = to >= text.length;
      let a = from;
      if (last && a > 0) a = text.slice(0, a).replace(/(?:\r?\n|\r)+$/, '').length;
      // …but keep the document's final line ending
      doc.replace(a, to, last && a < from ? (/(\r\n|\n|\r)$/.exec(text)?.[0] ?? '') : '');
      if (!doc.leaves.length) return { pos: 0 };
      const j = Math.min(doc.locate(a).i, doc.leaves.length - 1);
      const nl = doc.leaves[j];
      if (!isTextLeaf(nl)) return { widget: nl.id, at: last ? 'end' : 'start' } as Caret;
      return { pos: doc.docPos(j, last ? leafContent(nl).length : 0) };
    });
  } else {
    // a word / sentence takes one adjacent space with it so no double space remains
    const text = doc.text();
    let a = from;
    let b = to;
    if (text[b] === ' ' && (a === 0 || /\s/.test(text[a - 1]))) b++;
    else if (text[a - 1] === ' ' && (b >= text.length || /[\s.,;:!?)]/.test(text[b]))) a--;
    ed.replaceRange(a, b, '', null);
  }
  ed.hist.break();
  return true;
}

export function jumpTo(ed: EditorCore, target: JumpTarget): boolean {
  const doc = ed.doc;
  if (target === 'selection') {
    // the DOM selection survives scrolling; restore it only when focus left the editor
    if (!ed.readSel()) {
      const s = ed.lastSel;
      if (!s) return false;
      ed.setSel({ anchor: s.anchor, focus: s.focus }, false);
    }
    // bring the selection into the middle of the view
    const ds = getSelection();
    if (!ds?.rangeCount) return true;
    // centre on the focus end (a long selection may be taller than the view)
    const fr = document.createRange();
    fr.setStart(ds.focusNode!, ds.focusOffset);
    let r = fr.getBoundingClientRect();
    if (!r.height) r = (ds.focusNode!.nodeType === 1 ? (ds.focusNode as Element) : ds.focusNode!.parentElement!).getBoundingClientRect();
    const sc = scrollParent(ed.root);
    const box = sc === document.scrollingElement ? { top: 0, bottom: innerHeight } : sc.getBoundingClientRect();
    if (r.height) sc.scrollTop += r.top + r.height / 2 - (box.top + box.bottom) / 2;
    return true;
  }
  if (!doc.leaves.length) {
    ed.setSel({ pos: 0 });
    return true;
  }
  const i = target === 'top' ? 0 : doc.leaves.length - 1;
  const l = doc.leaves[i];
  if (!isTextLeaf(l)) {
    ed.setSel({ widget: l.id, at: target === 'top' ? 'start' : 'end' });
    return true;
  }
  const c = leafContent(l);
  ed.setSel({ pos: doc.docPos(i, target === 'top' ? splitBlockMeta(l, c)[0].length : c.length) });
  return true;
}
