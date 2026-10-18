/**
 * Block tools (#98): Paragraph › Table / Code Tools / Math Tools. The core finds
 * the widget block with the caret (or the last known caret) and hands the op to
 * `WidgetInstance.command`; Copy Math (core copy-as) and removals (Delete Table /
 * Delete Math) are done here.
 */
import type { CodeOp, MathOp, TableOp, WidgetBlockType, WidgetInstance } from '../../contracts';
import type { EditorCore } from './editor';
import type { Leaf } from './types';
import { leafContent } from './model';
import { isTextLeaf, widgetToParagraph, type Caret } from './edit';
import { copyAs } from './copy-as';

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

/**
 * Delete Table / Delete Math: remove the block; the caret goes to the start of the
 * next block (or the end of the previous one). The only block becomes an empty paragraph.
 */
function removeBlock(ed: EditorCore, id: string): void {
  const doc = ed.doc;
  ed.hist.break();
  ed.change(() =>
    ed.withLeaf(id, (i): Caret => {
      if (doc.leaves.length === 1) return widgetToParagraph(doc, i);
      const text = doc.text();
      const from = doc.start(i);
      const to = doc.start(i + 1);
      const last = to >= text.length;
      // removing the last block drops the separator before it but keeps the final line ending
      const a = last && from > 0 ? text.slice(0, from).replace(/(?:\r?\n|\r)+$/, '').length : from;
      doc.replace(a, to, last && a < from ? (/(\r\n|\n|\r)$/.exec(text)?.[0] ?? '') : '');
      const j = Math.min(doc.locate(a).i, doc.leaves.length - 1);
      const nl = doc.leaves[j];
      if (!isTextLeaf(nl)) return { widget: nl.id, at: last ? 'end' : 'start' };
      return { pos: doc.docPos(j, last ? leafContent(nl).length : 0) };
    }),
  );
  ed.hist.break();
}

export function tableTool(ed: EditorCore, op: TableOp, args: { rows?: number; cols?: number }): boolean {
  const hit = widgetAtCaret(ed, ['table']);
  if (!hit) return false;
  if (op === 'delete') {
    removeBlock(ed, hit.leaf.id);
    return true;
  }
  return hit.inst?.command?.(op, args) ?? false;
}

export function codeTool(ed: EditorCore, op: CodeOp): boolean {
  const hit = widgetAtCaret(ed, ['code_fence', 'math_block', 'html_block']);
  return hit?.inst?.command?.(op) ?? false;
}

export function mathTool(ed: EditorCore, op: MathOp): boolean {
  if (op === 'copyTex' || op === 'copyMathML') return copyAs(ed, op === 'copyTex' ? 'tex' : 'mathml');
  if (op === 'refresh') return refreshMath(ed);
  // delete: the math block with the caret (Typora has no Delete Math for inline $…$, typora-re#4)
  const hit = widgetAtCaret(ed, ['math_block']);
  if (!hit) return false;
  removeBlock(ed, hit.leaf.id);
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
