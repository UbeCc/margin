/**
 * Paragraph / Format menu commands beyond the basic toggles in commands.ts:
 * heading level ±1, insert paragraph before/after, task status, clear format,
 * footnote insertion. Each edit is a single undo step.
 */
import type { EditorCore } from './editor';
import { leafContent } from './model';
import * as E from './edit';
import { splitBlockMeta } from './render-inline';
import { parseInline, inlineSource, type INode } from './parser/inline';

function curLeaf(ed: EditorCore): number {
  if (!ed.doc.leaves.length) return -1;
  return ed.doc.locate(ed.sel().from).i;
}

/** Target level for Increase (+1) / Decrease (-1) Heading Level, or null when it does not apply. */
export function nextHeadingLevel(ed: EditorCore, delta: 1 | -1): 0 | 1 | 2 | 3 | 4 | 5 | 6 | null {
  const l = ed.doc.leaves[curLeaf(ed)];
  if (!l || (l.type !== 'paragraph' && l.type !== 'heading')) return null;
  const lv = l.type === 'heading' ? (l.level ?? 1) : 0;
  let next: number;
  if (delta > 0) next = lv === 0 ? 6 : lv - 1;
  else next = lv === 0 ? -1 : lv === 6 ? 0 : lv + 1;
  if (next < 0 || next === lv || (delta > 0 && lv === 1)) return null;
  return next as 0 | 1 | 2 | 3 | 4 | 5 | 6;
}

/** Insert an empty paragraph before / after the block containing the caret. */
export function insertParagraph(ed: EditorCore, where: 'before' | 'after'): boolean {
  const doc = ed.doc;
  const i = curLeaf(ed);
  const l = doc.leaves[i];
  if (!l) return false;
  ed.hist.break();
  const id = l.id;
  ed.change(() => {
    if (E.isTextLeaf(l) && l.type !== 'hr' && l.chain.length) {
      // inside a list / quote: a new sibling item / quoted paragraph
      const c = E.enter(doc, i, where === 'before' ? 0 : leafContent(l).length);
      if (where === 'after') return c;
      const j = doc.indexOf(id) - 1;
      return j >= 0 ? { pos: doc.docPos(j, 0) } : c;
    }
    const n = doc.leaves.length;
    for (let k = 0; k < 3 && doc.leaves.length === n; k++) {
      const j = doc.indexOf(id);
      const at = where === 'before' ? doc.start(j) : doc.start(j + 1);
      doc.replace(at, at, doc.eol);
    }
    const j = doc.indexOf(id);
    const t = where === 'before' ? j - 1 : j + 1;
    return doc.leaves[t] ? { pos: doc.docPos(t, 0) } : undefined;
  });
  ed.hist.break();
  return true;
}

/** Toggle / check / uncheck every task item touched by the selection. */
export function taskStatus(ed: EditorCore, op: 'toggle' | 'complete' | 'incomplete'): boolean {
  const doc = ed.doc;
  if (!doc.leaves.length) return false;
  const { from, to } = ed.sel();
  const i0 = doc.locate(from).i;
  const i1 = doc.locate(to).i;
  // the task box sits on the item's first leaf: walk back to it for continuation paragraphs
  const items: number[] = [];
  for (let i = i0; i <= i1; i++) {
    const chain = doc.leaves[i].chain;
    let idx = chain.length - 1;
    while (idx >= 0 && chain[idx].kind !== 'item') idx--;
    if (idx < 0) continue;
    const key = chain[idx].key;
    let k = i;
    while (k > 0 && doc.leaves[k].openFrom > idx && doc.leaves[k - 1].chain[idx]?.key === key) k--;
    if (!items.includes(k)) items.push(k);
  }
  const tasks = items.filter((k) => E.taskState(doc, k) !== null);
  if (!tasks.length) return false;
  const all = tasks.every((k) => E.taskState(doc, k));
  const want = op === 'complete' ? true : op === 'incomplete' ? false : !all;
  if (tasks.every((k) => E.taskState(doc, k) === want)) return true;
  const sel = ed.readSel() ?? ed.lastSel;
  ed.hist.break();
  ed.change(() => {
    for (const k of tasks.reverse()) E.setTask(doc, k, want);
    return sel ?? undefined;
  });
  ed.hist.break();
  return true;
}

const FORMAT_TAGS = new Set(['em', 'strong', 'del', 'mark', 'code', 'u', 'sub', 'sup', 'link']);

/** Source of `n` with formatting markers removed (links keep their text). */
function strip(n: INode): string {
  if (n.k !== 'wrap' || !FORMAT_TAGS.has(n.tag)) return inlineSource([n]);
  const ch = n.ch.slice(n.ch[0]?.k === 'meta' ? 1 : 0, n.ch[n.ch.length - 1]?.k === 'meta' ? -1 : undefined);
  return ch.map(strip).join('');
}

/** Clear formatting in body[from, to) — wraps touching the range are removed whole. */
export function clearRange(body: string, from: number, to: number): { s: number; e: number; text: string } {
  const nodes = parseInline(body);
  const spans: [INode, number, number][] = [];
  let p = 0;
  for (const n of nodes) {
    const len = inlineSource([n]).length;
    spans.push([n, p, p + len]);
    p += len;
  }
  let s = from;
  let e = to;
  for (const [n, a, b] of spans) {
    if (n.k === 'wrap' && b > from && a < to) {
      s = Math.min(s, a);
      e = Math.max(e, b);
    }
  }
  let text = '';
  for (const [n, a, b] of spans) {
    if (b <= s || a >= e) continue;
    text += n.k === 'wrap' ? strip(n) : body.slice(Math.max(a, s), Math.min(b, e));
  }
  return { s, e, text };
}

/** Format › Clear Format on the selection (the whole block when collapsed). */
export function clearFormat(ed: EditorCore): boolean {
  const doc = ed.doc;
  if (!doc.leaves.length) return false;
  const { from, to } = ed.sel();
  const a = doc.locate(from);
  const b = doc.locate(to);
  const edits: { i: number; next: string; s: number; e: number }[] = [];
  for (let i = a.i; i <= b.i; i++) {
    const l = doc.leaves[i];
    if (!E.isTextLeaf(l) || l.type === 'hr') continue;
    const c = leafContent(l);
    const [pre, body] = splitBlockMeta(l, c);
    let f = (i === a.i ? a.off : 0) - pre.length;
    let t = (i === b.i ? b.off : c.length) - pre.length;
    if (from === to) [f, t] = [0, body.length];
    f = Math.max(0, Math.min(body.length, f));
    t = Math.max(f, Math.min(body.length, t));
    const r = clearRange(body, f, t);
    const next = c.slice(0, pre.length + r.s) + r.text + c.slice(pre.length + r.e);
    if (next !== c) edits.push({ i, next, s: pre.length + r.s, e: pre.length + r.s + r.text.length });
  }
  if (!edits.length) return false;
  const ids = edits.map((x) => doc.leaves[x.i].id);
  ed.hist.break();
  ed.change(() => {
    for (const x of [...edits].reverse()) doc.setContent(x.i, x.next);
    const fi = doc.indexOf(ids[0]);
    const li = doc.indexOf(ids[ids.length - 1]);
    if (fi < 0 || li < 0) return undefined;
    return { anchor: doc.docPos(fi, edits[0].s), focus: doc.docPos(li, edits[edits.length - 1].e) };
  });
  ed.hist.break();
  return true;
}

/** Next unused numeric footnote label. */
export function nextFootnoteLabel(md: string): string {
  let max = 0;
  for (const m of md.matchAll(/\[\^(\d+)\]/g)) max = Math.max(max, Number(m[1]));
  return String(max + 1);
}

/** Paragraph › Footnotes: insert `[^n]` at the caret and its `[^n]: ` definition at the end. */
export function insertFootnote(ed: EditorCore): boolean {
  const doc = ed.doc;
  const { to } = ed.sel();
  const at = doc.leaves.length ? doc.locate(to) : null;
  const l = at && doc.leaves[at.i];
  if (l && (!E.isTextLeaf(l) || l.type === 'hr')) return false;
  const label = nextFootnoteLabel(doc.text());
  ed.hist.break();
  ed.change(() => {
    if (l && at) {
      const c = leafContent(l);
      doc.setContent(at.i, c.slice(0, at.off) + `[^${label}]` + c.slice(at.off));
    } else doc.replace(0, 0, `[^${label}]`);
    const t = doc.text();
    const sep = (/[\r\n]$/.test(t) ? '' : doc.eol) + doc.eol;
    doc.replace(t.length, t.length, `${sep}[^${label}]: `);
    const j = doc.leaves.length - 1;
    return { pos: doc.docPos(j, leafContent(doc.leaves[j]).length) };
  });
  ed.hist.break();
  return true;
}

/** Definition leaf of footnote `label` (`[^label]: …`): leaf index + content offset of its text. */
export function footnoteDef(doc: EditorCore['doc'], label: string): { i: number; off: number; text: string } | null {
  for (let i = 0; i < doc.leaves.length; i++) {
    const l = doc.leaves[i];
    if (l.type !== 'footnote') continue;
    const c = leafContent(l);
    const [pre, body] = splitBlockMeta(l, c);
    if (pre.trim().slice(2, -2) === label) return { i, off: pre.length, text: body };
  }
  return null;
}

/** First `[^label]` reference outside its definition: leaf index + content offset just after it. */
export function footnoteRef(doc: EditorCore['doc'], label: string): { i: number; off: number } | null {
  const needle = `[^${label}]`;
  for (let i = 0; i < doc.leaves.length; i++) {
    const l = doc.leaves[i];
    if (!E.isTextLeaf(l)) continue;
    const c = leafContent(l);
    const from = l.type === 'footnote' ? splitBlockMeta(l, c)[0].length : 0;
    const k = c.indexOf(needle, from);
    if (k >= 0 && !c.startsWith(':', k + needle.length)) return { i, off: k + needle.length };
  }
  return null;
}
