/**
 * Find / replace over the document source, including matches inside widget
 * blocks (#35): a match in a widget is handed to `WidgetInstance.select(from, to)`
 * with offsets into that widget's raw (container prefixes stripped, '\n' line
 * ends); widgets without `select` (or returning false) get the whole block focused.
 */
import type { EditorCore } from './editor';
import { isTextLeaf } from './edit';
import { allMatches, compileQuery, findMatch, type FindOptions } from './query';
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

export function find(ed: EditorCore, q: string, cs: boolean | FindOptions = false, back = false, at?: { from: number; to: number }): boolean {
  const o: FindOptions = typeof cs === 'boolean' ? { caseSensitive: cs } : cs;
  const { from, to } = at ?? range(ed);
  const m = findMatch(ed.doc.text(), q, from, to, o, back);
  if (!m) return false;
  selectMatch(ed, m.index, m.index + m.length);
  return true;
}

/**
 * Replace the current match (or all). With `regex`, the replacement expands
 * `$1`, `$<name>`, `$&` like String.prototype.replace; otherwise it is literal.
 */
export function replace(ed: EditorCore, q: string, rep: string, all = false, cs: boolean | FindOptions = false): boolean {
  const o: FindOptions = typeof cs === 'boolean' ? { caseSensitive: cs } : cs;
  const re = compileQuery(q, o);
  if (!re) return false;
  const text = ed.doc.text();
  const expand = (m: RegExpExecArray) => (o.regex ? expandReplacement(rep, m) : rep);
  if (all) {
    const ms = allMatches(text, re);
    if (!ms.length) return false;
    let next = '';
    let p = 0;
    for (const m of ms) {
      next += text.slice(p, m.index) + expand(m.match);
      p = m.index + m.length;
    }
    next += text.slice(p);
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
  // the selection is exactly a match: replace it, then move to the next one
  const cur = allMatches(text, re).find((m) => m.index === from && m.index + m.length === to);
  if (cur) {
    hits.delete(ed);
    const r = expand(cur.match);
    ed.hist.break();
    ed.replaceRange(from, to, r, null);
    ed.hist.break();
    const p = from + r.length;
    find(ed, q, o, false, { from: p, to: p });
    return true;
  }
  return find(ed, q, o);
}

/** `$$`, `$&`, `$1`…`$99`, `$<name>` in a regex replacement (String.prototype.replace semantics). */
export function expandReplacement(rep: string, m: RegExpExecArray): string {
  return rep.replace(/\$(\$|&|\d{1,2}|<([^>]*)>)/g, (all, t: string, name?: string) => {
    if (t === '$') return '$';
    if (t === '&') return m[0];
    if (name !== undefined) return m.groups?.[name] ?? '';
    const n = Number(t);
    if (n > 0 && n < m.length) return m[n] ?? '';
    if (t.length === 2 && Number(t[0]) > 0 && Number(t[0]) < m.length) return (m[Number(t[0])] ?? '') + t[1];
    return all;
  });
}
