/**
 * Find / replace over the document source, including matches inside widget
 * blocks (#35): a match in a widget is handed to `WidgetInstance.select(from, to)`
 * with offsets into that widget's raw (container prefixes stripped, '\n' line
 * ends); widgets without `select` (or returning false) get the whole block focused.
 */
import type { EditorCore } from './editor';
import { isTextLeaf } from './edit';
import { findIn } from './query';
import type { Line } from './types';

/**
 * Offset into a widget's raw (`widgetRaw`: line texts joined by '\n') of document
 * position `pos`, for a leaf laid out from `base`. Positions inside a container
 * prefix clamp to the start of that line's text; inside a CRLF to its end.
 */
export function rawOffset(lines: Line[], base: number, pos: number): number {
  let p = base;
  let r = 0;
  for (const ln of lines) {
    const t = p + ln.prefix.length;
    if (pos < t) return r;
    if (pos <= t + ln.text.length) return r + pos - t;
    const next = t + ln.text.length + ln.eol.length;
    if (pos < next) return r + ln.text.length;
    p = next;
    r += ln.text.length + (ln.eol ? 1 : 0);
  }
  return r;
}

interface WidgetHit {
  id: string;
  from: number;
  to: number;
  text: string;
}

/** Last match selected inside a widget (the DOM selection there maps to the whole block). */
const hits = new WeakMap<EditorCore, WidgetHit>();

/**
 * Current find range: the last widget match while focus is still in that widget (or
 * outside the editor, e.g. in the find bar) and the document is unchanged; else the
 * selection.
 */
function range(ed: EditorCore): { from: number; to: number } {
  const h = hits.get(ed);
  const a = document.activeElement;
  if (h && h.text === ed.doc.text() && (!a || !ed.root.contains(a) || ed.view.blockOf(a)?.id === h.id)) {
    // the caret must not have moved to another block since (lastSel tracks selectionchange)
    const i = ed.doc.indexOf(h.id);
    const f = ed.lastSel?.focus ?? h.from;
    if (i >= 0 && f >= ed.doc.start(i) && f <= ed.doc.start(i + 1)) return { from: h.from, to: h.to };
  }
  return ed.sel();
}

/** Select document range `[from, to)`; inside a widget delegate to its `select`. */
export function selectMatch(ed: EditorCore, from: number, to: number): void {
  hits.delete(ed);
  const { i } = ed.doc.locate(from);
  const l = ed.doc.leaves[i];
  if (!l || isTextLeaf(l)) {
    ed.setSel({ anchor: from, focus: to });
    return;
  }
  const base = ed.doc.start(i);
  const inst = ed.view.widget(l.id);
  ed.view.setFocus(l.id, null);
  let ok = false;
  if (to <= ed.doc.start(i + 1) && inst?.select) {
    try {
      ok = inst.select(rawOffset(l.lines, base, from), rawOffset(l.lines, base, to));
    } catch {
      ok = false;
    }
  }
  if (!ok) inst?.focus('start');
  ed.lastSel = { anchor: from, focus: to };
  hits.set(ed, { id: l.id, from, to, text: ed.doc.text() });
  ed.emitSel();
}

export function find(ed: EditorCore, q: string, cs = false, back = false, at?: { from: number; to: number }): boolean {
  const { from, to } = at ?? range(ed);
  const i = findIn(ed.doc.text(), q, from, to, cs, back);
  if (i < 0) return false;
  selectMatch(ed, i, i + q.length);
  return true;
}

export function replace(ed: EditorCore, q: string, rep: string, all = false, cs = false): boolean {
  if (!q) return false;
  const text = ed.doc.text();
  const eq = (a: string) => (cs ? a === q : a.toLowerCase() === q.toLowerCase());
  if (all) {
    const re = new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), cs ? 'g' : 'gi');
    const next = text.replace(re, () => rep);
    if (next === text) return false;
    ed.hist.break();
    ed.change(() => {
      ed.doc.replace(0, text.length, next);
      return { pos: 0 };
    });
    ed.hist.break();
    return true;
  }
  const { from, to } = range(ed);
  if (to - from === q.length && eq(text.slice(from, to))) {
    hits.delete(ed);
    ed.hist.break();
    ed.replaceRange(from, to, rep, null);
    ed.hist.break();
    const p = from + rep.length;
    find(ed, q, cs, false, { from: p, to: p });
    return true;
  }
  return find(ed, q, cs);
}
