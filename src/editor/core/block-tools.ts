/**
 * Block tools (#98): Paragraph › Table / Code Tools / Math Tools. The core finds
 * the widget block with the caret (or the last known caret) and hands the op to
 * `WidgetInstance.command`; clipboard ops that need core helpers (Copy Table,
 * Copy Math) and removals (Delete Table / Delete Math) are done here.
 */
import type { CodeOp, MathOp, TableOp, WidgetBlockType, WidgetInstance } from '../../contracts';
import type { EditorCore } from './editor';
import type { Leaf } from './types';
import { leafContent, widgetRaw } from './model';
import { isTextLeaf, widgetToParagraph } from './edit';
import { copyAs, lastCopyAs, writePayload } from './copy-as';

/** Markdown of an empty `rows`×`cols` table (rows include the header row; both clamped to 1…200). */
export function tableMarkdown(rows: number, cols: number): string {
  const clamp = (n: number) => Math.min(200, Math.max(1, Math.floor(n) || 1));
  const R = clamp(rows);
  const C = clamp(cols);
  const row = (cell: string) => '|' + Array(C).fill(cell).join('|') + '|';
  const out = [row('   '), row(' --- ')];
  for (let r = 1; r < R; r++) out.push(row('   '));
  return out.join('\n');
}

interface Hit {
  i: number;
  leaf: Leaf;
  inst: WidgetInstance | undefined;
}

/** Widget block of type `types` with the caret (else the last caret, else the focused block). */
export function widgetAtCaret(ed: EditorCore, types: WidgetBlockType[]): Hit | null {
  const doc = ed.doc;
  if (!doc.leaves.length) return null;
  const ok = (i: number): Hit | null => {
    const l = doc.leaves[i];
    if (!l || isTextLeaf(l)) return null;
    const rec = ed.view.recs.get(l.id);
    if (!rec?.wtype || !types.includes(rec.wtype)) return null;
    return { i, leaf: l, inst: rec.inst };
  };
  const s = ed.readSel() ?? ed.lastSel;
  if (s) return ok(doc.locate(s.focus).i);
  const f = ed.view.focusId;
  return f ? ok(doc.indexOf(f)) : null;
}

function removeBlock(ed: EditorCore, id: string): void {
  ed.hist.break();
  ed.change(() => ed.withLeaf(id, (i) => widgetToParagraph(ed.doc, i)), null);
  ed.hist.break();
}

const BORDER = 'border:1px solid #c8c8c8;padding:4px 8px';

/** Copy Table: markdown source as plain text, the rendered table (inline borders) as HTML. */
export function copyTable(ed: EditorCore, hit: Hit): boolean {
  const md = widgetRaw(hit.leaf).replace(/(\r?\n)+$/, '');
  let html = hit.inst?.renderHTML() ?? '';
  html = html
    .replace(/<table>/g, '<table style="border-collapse:collapse">')
    .replace(/<(th|td)( style="([^"]*)")?>/g, (_m, tag: string, _s, st?: string) => `<${tag} style="${BORDER}${st ? ';' + st : ''}">`);
  const p = { 'text/plain': md, 'text/html': html };
  lastCopyAs.set(ed, p);
  void writePayload(p);
  return true;
}

export function tableTool(ed: EditorCore, op: TableOp, args: { rows?: number; cols?: number }): boolean {
  const hit = widgetAtCaret(ed, ['table']);
  if (!hit) return false;
  if (op === 'copy') return copyTable(ed, hit);
  if (op === 'delete') {
    removeBlock(ed, hit.leaf.id);
    return true;
  }
  return hit.inst?.command?.(op, args) ?? false;
}

export function codeTool(ed: EditorCore, op: CodeOp): boolean {
  const hit = widgetAtCaret(ed, ['code_fence']);
  return hit?.inst?.command?.(op) ?? false;
}

/** Inline `$…$` range (content offsets) around the caret in text block `i`. */
function inlineMathRange(ed: EditorCore): { i: number; from: number; to: number } | null {
  const s = ed.readSel() ?? ed.lastSel;
  if (!s) return null;
  const { i, off } = ed.doc.locate(s.focus);
  const l = ed.doc.leaves[i];
  if (!l || !isTextLeaf(l)) return null;
  const c = leafContent(l);
  const re = /(?<![\\$])\$(?!\$)((?:\\.|[^$\\\n])+?)\$(?!\$)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(c))) if (off >= m.index && off <= m.index + m[0].length) return { i, from: m.index, to: m.index + m[0].length };
  return null;
}

export function mathTool(ed: EditorCore, op: MathOp): boolean {
  if (op === 'copyTex' || op === 'copyMathML') return copyAs(ed, op === 'copyTex' ? 'tex' : 'mathml');
  if (op === 'refresh') return refreshMath(ed);
  // delete: the math block with the caret, else the inline $…$ around the caret
  const hit = widgetAtCaret(ed, ['math_block']);
  if (hit) {
    removeBlock(ed, hit.leaf.id);
    return true;
  }
  const r = inlineMathRange(ed);
  if (!r) return false;
  const from = ed.doc.docPos(r.i, r.from);
  const to = ed.doc.docPos(r.i, r.to);
  ed.hist.break();
  ed.change(() => {
    ed.doc.replace(from, to, '');
    return { pos: from };
  });
  ed.hist.break();
  return true;
}

/** Refresh All Math Expressions: re-render every math block and inline formula. */
export function refreshMath(ed: EditorCore): boolean {
  for (const rec of ed.view.recs.values()) if (rec.wtype === 'math_block') rec.inst?.command?.('refresh');
  const s = ed.readSel() ?? ed.lastSel;
  const inWidget = !!ed.root.querySelector('.mb-block')?.contains(document.activeElement);
  ed.view.sync(true);
  if (s && !inWidget && document.activeElement === ed.root) ed.setSel(s, false);
  return true;
}
