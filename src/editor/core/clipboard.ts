/** Copy (markdown as text/plain + HTML), cut, paste (md / HTML→md / images), drop. */
import type { EditorCore } from './editor';
import { Doc, contPrefix, leafContent, widgetRaw } from './model';
import { isTextLeaf } from './edit';
import { docHTML } from './html';
import { splitBlockMeta } from './render-inline';
import { htmlToMarkdown } from './paste';
import { MARGIN_MIME, buildCopyFlavors, pickPasteMarkdown, writeFlavors, type CopyFlavors } from './clipboard-flavors';
import { htmlToRtf } from './clipboard-rtf';
import { plainFromClipboard } from './copy-as';

export { MARGIN_HTML_ATTR, MARGIN_MIME } from './clipboard-flavors';

export function selectionMarkdown(ed: EditorCore): { from: number; to: number; md: string } | null {
  const s = ed.readSel();
  if (!s || s.anchor === s.focus) return null;
  const from = expandToBlockStart(ed.doc, Math.min(s.anchor, s.focus), Math.max(s.anchor, s.focus));
  const to = Math.max(s.anchor, s.focus);
  return { from, to, md: ed.doc.text().slice(from, to) };
}

/**
 * Hidden block markers (`# `, `- `, `> `) sit before the caret's first
 * visible position, so a selection made by dragging or select-all starts after
 * them. When such a selection runs past the end of its first block, widen it to
 * the start of that line so the copy carries the block syntax (#79).
 */
export function expandToBlockStart(doc: Doc, from: number, to: number): number {
  if (!doc.leaves.length) return from;
  const a = doc.locate(from);
  const l = doc.leaves[a.i];
  if (!l || !isTextLeaf(l)) return from;
  const lead = splitBlockMeta(l, leafContent(l))[0];
  if (a.off > lead.length) return from;
  const text = doc.text();
  let lineEnd = text.indexOf('\n', from);
  if (lineEnd < 0) lineEnd = text.length;
  else if (text[lineEnd - 1] === '\r') lineEnd--;
  // whole rest of a marked line (heading), or the selection continues onto later lines
  if (!(to > lineEnd || (lead && to >= lineEnd))) return from;
  return text.lastIndexOf('\n', from - 1) + 1;
}

/**
 * Rendered HTML of the copied markdown. Widgets (tables, code, math…) that are
 * copied whole render through their mounted instance, matched by exact source.
 */
export function selectionHTML(ed: EditorCore, md: string): string {
  const key = (l: Parameters<typeof widgetRaw>[0]) => widgetRaw(l).replace(/\n+$/, '');
  const mounted = new Map<string, string>();
  for (const l of ed.doc.leaves) if (!isTextLeaf(l)) mounted.set(key(l), l.id);
  return docHTML(new Doc(md), ed.view.inlineCtx(), (l) => {
    const id = mounted.get(key(l));
    if (!id) return null;
    try {
      return ed.view.widget(id)?.renderHTML() ?? null;
    } catch {
      return null;
    }
  });
}

export function onCopy(ed: EditorCore, e: ClipboardEvent, cut: boolean): void {
  const sel = selectionMarkdown(ed);
  if (!sel || !e.clipboardData) return;
  e.preventDefault();
  const html = selectionHTML(ed, sel.md);
  const rich = ed.settings.writeClipboardRich;
  const nonce = rich ? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}` : undefined;
  const flavors = buildCopyFlavors(sel.md, html, nonce);
  writeFlavors(e.clipboardData, flavors);
  if (rich && nonce) scheduleRich(rich, flavors, html, nonce);
  if (cut) ed.replaceRange(sel.from, sel.to, '', null);
}

type RichWriter = NonNullable<EditorCore['settings']['writeClipboardRich']>;

/**
 * After the copy event returns (WebKit writes the DataTransfer flavours to the
 * pasteboard then), add RTF natively. The native side waits for the nonce to
 * appear in public.html before appending, so it never clobbers a newer copy.
 */
function scheduleRich(rich: RichWriter, f: CopyFlavors, renderedHtml: string, nonce: string): void {
  setTimeout(() => {
    let rtf: string;
    try {
      rtf = htmlToRtf(renderedHtml);
    } catch {
      return;
    }
    rich({ plain: f.plain, html: f.html, rtf, markdown: f.markdown, marker: nonce }).catch(() => undefined);
  }, 0);
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
    if (src && /^(?:!\[|<img\b)/i.test(src)) out.push(src); // #99: complete snippet from the shell
    else if (src) out.push(`![${f.name.replace(/\.[^.]+$/, '').replace(/[[\]]/g, '')}](${src.replace(/ /g, '%20')})`);
  }
  return out;
}

const BLOCK_START = /^ {0,3}(?:#{1,6}(?:[ \t]|$)|[-+*][ \t]|\d{1,9}[.)][ \t]|>|```|~~~|\$\$|\||(?:[-*_][ \t]*){3,}$)/;

/**
 * Fit multi-line markdown to the insertion point: continuation lines get the
 * container prefixes of the target block (so pasted lines stay inside the
 * list item / quote), and block-level content pasted mid-text splits the
 * block instead of gluing `# H` onto the text before the caret.
 */
export function fitToContext(doc: Doc, md: string, from: number, to: number): string {
  if (!md.includes('\n') || !doc.leaves.length) return md;
  const a = doc.locate(from);
  const b = doc.locate(to);
  const l = doc.leaves[a.i];
  const lb = doc.leaves[b.i];
  if (!l || !lb || !isTextLeaf(l) || !isTextLeaf(lb) || l.type === 'indented_code') return md;
  const E = doc.eol;
  const p = contPrefix(l.chain);
  const pb = contPrefix(l.chain, true);
  const lines = md.replace(/\r\n?|\n/g, '\n').replace(/\n+$/, '').split('\n');
  if (lines.length === 1) return lines[0];

  // Pasted list items inside a list item become its siblings: from the first
  // unindented marker line on, lines get the parent level's prefix.
  const inner = l.chain[l.chain.length - 1];
  const po = inner?.kind === 'item' ? contPrefix(l.chain.slice(0, -1)) : p;
  const isItem = (x: string) => /^ {0,3}(?:[-+*]|\d{1,9}[.)])(?:[ \t]|$)/.test(x);
  // list lines pasted into a list item join the list instead of splitting the item
  const blockLine = (x: string) => BLOCK_START.test(x) && !(po !== p && isItem(x));
  const blocky = lines.some((x) => !x.trim()) || BLOCK_START.test(lines[0]) || lines.slice(1).some(blockLine);
  let sib = false;
  let out = lines
    .map((x, k) => {
      if (k === 0) return x;
      if (po !== p && /^(?:[-+*]|\d{1,9}[.)])(?:[ \t]|$)/.test(x)) sib = true;
      return (x.trim() ? (sib ? po : p) : sib ? po.replace(/[ ]+$/, '') : pb) + x;
    })
    .join(E);
  if (blocky) {
    if (leafContent(l).slice(0, a.off).trim()) out = E + pb + E + p + out;
    if (leafContent(lb).slice(b.off).trim()) out = out + E + pb + E + p;
  }
  return out;
}

export function insertMarkdown(ed: EditorCore, md: string, range = ed.sel()): void {
  md = fitToContext(ed.doc, md, range.from, range.to);
  ed.hist.break();
  ed.replaceRange(range.from, range.to, md, null);
  ed.hist.break();
}

export function onPaste(ed: EditorCore, e: ClipboardEvent, plain = false): void {
  const dt = e.clipboardData;
  if (!dt) return;
  e.preventDefault();
  const range = ed.sel();
  if (plain) {
    // Paste as Plain Text (#96): no images, formatting reduced to text
    const t = plainFromClipboard((x) => dt.getData(x)).replace(/\r\n?/g, ed.doc.eol);
    if (t) insertMarkdown(ed, t, range);
    return;
  }
  const files = Array.from(dt.files ?? []).filter((f) => f.type.startsWith('image/'));
  if (files.length) {
    void storeFiles(ed, files).then((imgs) => imgs.length && insertMarkdown(ed, imgs.join(' '), range));
    return;
  }
  // RTF-only clipboards (TextEdit, Pages, Word): the engine exposes no HTML; ask the native side to convert (#96)
  const types = Array.from(dt.types ?? []);
  if (ed.settings.readClipboard && !types.includes('text/html') && !types.includes(MARGIN_MIME)) {
    const plain = dt.getData('text/plain');
    void ed.settings
      .readClipboard()
      .catch(() => null)
      .then((s) => {
        let out = plain;
        if (s?.rtfHtml && !s.html) {
          try {
            out = htmlToMarkdown(s.rtfHtml) || plain;
          } catch {
            out = plain;
          }
        }
        out = out.replace(/\r\n?/g, ed.doc.eol);
        if (out) insertMarkdown(ed, out, range);
      });
    return;
  }
  let { md } = pickPasteMarkdown((t) => dt.getData(t), htmlToMarkdown);
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
