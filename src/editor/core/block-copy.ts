/**
 * Copy the block at the caret (#97 context menus): Table › Copy Table, Code
 * Tools › Copy Code Content. `source` = the block's markdown (container
 * prefixes stripped, trailing blank lines dropped); `content` = the inner text
 * of fenced code / diagram / math blocks without the fence lines.
 */
import type { EditorCore } from './editor';
import { leafContent } from './model';
import { lastCopyAs, writePayload } from './copy-as';

/** Inner content of a fenced (``` / ~~~) or `$$` block source; other sources unchanged. */
export function blockInner(type: string, src: string): string {
  const lines = src.split('\n');
  if (type === 'code_fence' || type === 'diagram') {
    const open = /^(\s*)(`{3,}|~{3,})/.exec(lines[0] ?? '');
    if (!open) return src;
    const fence = open[2];
    let end = lines.length;
    const last = lines[lines.length - 1] ?? '';
    if (lines.length > 1 && new RegExp('^\\s*' + fence[0] + '{' + fence.length + ',}\\s*$').test(last)) end--;
    return lines.slice(1, end).join('\n');
  }
  if (type === 'math_block') {
    let body = src.replace(/^\s*\$\$[ \t]*/, '');
    body = body.replace(/\n?[ \t]*\$\$\s*$/, '');
    return body.replace(/^\n/, '');
  }
  return src;
}

/** Text of the block at the caret for `part`, or null when there is no block. */
export function blockText(ed: EditorCore, part: 'source' | 'content'): string | null {
  const doc = ed.doc;
  if (!doc.leaves.length) return null;
  const s = ed.readSel() ?? ed.lastSel;
  const l = doc.leaves[doc.locate(s ? Math.min(s.anchor, s.focus) : 0).i];
  if (!l) return null;
  const src = leafContent(l);
  return part === 'content' ? blockInner(l.type, src) : src;
}

export function copyBlock(ed: EditorCore, part: 'source' | 'content'): boolean {
  const text = blockText(ed, part);
  if (text === null) return false;
  const p = { 'text/plain': text };
  lastCopyAs.set(ed, p);
  void writePayload(p);
  return true;
}
