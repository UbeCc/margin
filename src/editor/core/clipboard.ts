/** Copy (markdown as text/plain + HTML), cut, paste (md / HTML→md / images), drop. */
import type { EditorCore } from './editor';
import { Doc } from './model';
import { docHTML } from './html';
import { htmlToMarkdown } from './paste';

export const MARGIN_HTML_ATTR = 'data-margin-md';

export function selectionMarkdown(ed: EditorCore): { from: number; to: number; md: string } | null {
  const s = ed.readSel();
  if (!s || s.anchor === s.focus) return null;
  const from = Math.min(s.anchor, s.focus);
  const to = Math.max(s.anchor, s.focus);
  return { from, to, md: ed.doc.text().slice(from, to) };
}

export function onCopy(ed: EditorCore, e: ClipboardEvent, cut: boolean): void {
  const sel = selectionMarkdown(ed);
  if (!sel || !e.clipboardData) return;
  e.preventDefault();
  const tmp = new Doc(sel.md);
  const html = docHTML(tmp, ed.view.inlineCtx(), () => null);
  e.clipboardData.setData('text/plain', sel.md);
  e.clipboardData.setData('text/html', `<div ${MARGIN_HTML_ATTR}="">${html}</div>`);
  if (cut) ed.replaceRange(sel.from, sel.to, '', null);
}

async function storeFiles(ed: EditorCore, files: File[]): Promise<string[]> {
  const out: string[] = [];
  for (const f of files) {
    if (!f.type.startsWith('image/')) continue;
    let src: string | null = null;
    if (ed.settings.storeImage) {
      const bytes = new Uint8Array(await f.arrayBuffer());
      const path = (f as File & { path?: string }).path;
      src = await ed.settings.storeImage({ bytes, mime: f.type, name: f.name, ...(path ? { path } : {}) });
    } else src = URL.createObjectURL(f);
    if (src) out.push(`![${f.name.replace(/\.[^.]+$/, '').replace(/[[\]]/g, '')}](${src.replace(/ /g, '%20')})`);
  }
  return out;
}

export function insertMarkdown(ed: EditorCore, md: string, range = ed.sel()): void {
  ed.hist.break();
  ed.replaceRange(range.from, range.to, md, null);
  ed.hist.break();
}

export function onPaste(ed: EditorCore, e: ClipboardEvent): void {
  const dt = e.clipboardData;
  if (!dt) return;
  e.preventDefault();
  const range = ed.sel();
  const files = Array.from(dt.files ?? []).filter((f) => f.type.startsWith('image/'));
  if (files.length) {
    void storeFiles(ed, files).then((imgs) => imgs.length && insertMarkdown(ed, imgs.join(' '), range));
    return;
  }
  const html = dt.getData('text/html');
  const text = dt.getData('text/plain');
  let md = text;
  if (html && !html.includes(MARGIN_HTML_ATTR) && /<(?:p|h[1-6]|ul|ol|li|strong|b|em|i|a|img|pre|code|table|blockquote|br)\b/i.test(html)) {
    try {
      md = htmlToMarkdown(html) || text;
    } catch {
      md = text;
    }
  }
  md = md.replace(/\r\n?/g, ed.doc.eol);
  if (md) insertMarkdown(ed, md, range);
}

export function onDrop(ed: EditorCore, e: DragEvent): void {
  const files = Array.from(e.dataTransfer?.files ?? []).filter((f) => f.type.startsWith('image/'));
  if (!files.length) return;
  e.preventDefault();
  const pos = caretFromPoint(e.clientX, e.clientY);
  const at = pos ? ed.pointToPos(pos.node, pos.offset) : null;
  const range = at === null ? ed.sel() : { from: at, to: at };
  void storeFiles(ed, files).then((imgs) => imgs.length && insertMarkdown(ed, imgs.join(' '), range));
}

function caretFromPoint(x: number, y: number): { node: Node; offset: number } | null {
  const d = document as Document & {
    caretPositionFromPoint?(x: number, y: number): { offsetNode: Node; offset: number } | null;
    caretRangeFromPoint?(x: number, y: number): Range | null;
  };
  const p = d.caretPositionFromPoint?.(x, y);
  if (p) return { node: p.offsetNode, offset: p.offset };
  const r = d.caretRangeFromPoint?.(x, y);
  return r ? { node: r.startContainer, offset: r.startOffset } : null;
}
