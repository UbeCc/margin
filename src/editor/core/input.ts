/**
 * DOM event handling for the contenteditable root. Plain typing and deletion
 * are applied to the model from `beforeinput` (target ranges → document
 * positions); IME composition is left to the browser and read back on
 * compositionend; structural keys go through edit.ts.
 */
import { pastePlain } from './copy-as';
import { EditorCore } from './editor';
import { EMPTY_ID } from './view';
import { leafContent } from './model';
import * as E from './edit';
import { onCopy, onPaste, onDrop } from './clipboard';
import { undo, redo } from './commands';
import { footnoteDef, footnoteRef } from './para-cmds';
import { parseInline, inlinePlain } from './parser/inline';
import { splitBlockMeta } from './render-inline';
import type { Leaf } from './types';

/** Length of a text leaf's leading hidden block marker ("## ", "[^1]: "). */
function metaLen(l: Leaf): number {
  return splitBlockMeta(l, leafContent(l))[0].length;
}

export function attachInput(ed: EditorCore): () => void {
  const root = ed.root;
  const inWidget = (n: EventTarget | Node | null) => {
    const el = n instanceof Element ? n : (n as Node | null)?.parentElement;
    return !!el?.closest('.md-widget');
  };
  const caretBlock = () => {
    const s = getSelection();
    return s && s.rangeCount ? ed.view.blockOf(s.focusNode) : null;
  };
  /** Collapsed caret in a text leaf: { i, off }. */
  const caretLeaf = () => {
    const s = ed.readSel();
    if (!s || s.anchor !== s.focus || !ed.doc.leaves.length) return null;
    const b = caretBlock();
    if (!b) return null;
    const i = ed.doc.indexOf(b.id);
    if (i < 0 || !E.isTextLeaf(ed.doc.leaves[i])) return null;
    const loc = ed.doc.locate(s.focus);
    return loc.i === i ? { i, off: loc.off, pos: s.focus } : null;
  };
  const rangeOf = (e: InputEvent) => {
    const rs = e.getTargetRanges?.() ?? [];
    if (rs.length) {
      const r = rs[0];
      const a = ed.pointToPos(r.startContainer, r.startOffset);
      const b = ed.pointToPos(r.endContainer, r.endOffset, true);
      if (a !== null && b !== null) return { from: Math.min(a, b), to: Math.max(a, b) };
    }
    const s = ed.readSel();
    return s ? { from: Math.min(s.anchor, s.focus), to: Math.max(s.anchor, s.focus) } : null;
  };

  const enter = (soft: boolean) => {
    const s = ed.sel();
    if (s.from !== s.to) ed.replaceRange(s.from, s.to, '', null);
    if (!ed.doc.leaves.length) {
      ed.change(() => {
        ed.doc.replace(0, 0, ed.doc.eol + ed.doc.eol);
        return { pos: 2 * ed.doc.eol.length };
      });
      return;
    }
    const c = caretLeaf();
    if (!c) return;
    ed.hist.break();
    ed.change(() => E.enter(ed.doc, c.i, c.off, soft));
    ed.hist.break();
  };

  /** Editor › Auto Pair (#100): insert the closing bracket/quote/marker, or step over an existing one. */
  const autoPair = (pos: number, ch: string, key: string): boolean => {
    const o = ed.md();
    const md = o.autoPairMarkdown && MD_PAIRS.includes(ch);
    if (!o.autoPairBrackets && !md) return false;
    const loc = ed.doc.locate(pos);
    const l = ed.doc.leaves[loc.i];
    if (!l || !E.isTextLeaf(l) || ed.doc.docPos(loc.i, loc.off) !== pos) return false;
    const c = leafContent(l);
    const prev = c[loc.off - 1] ?? '';
    const next = c[loc.off] ?? '';
    const close = o.autoPairBrackets ? BRACKETS[ch] : md ? ch : undefined;
    let k = loc.off;
    while (k > 0 && c[k - 1] === ch) k--;
    const emptyPair = prev === ch && !/[\p{L}\p{N}]/u.test(c[k - 1] ?? '');
    if (md && next === ch && !emptyPair) {
      ed.setSel({ pos: pos + 1 }); // step over the auto-inserted closing marker
      return true;
    }
    if (!md && o.autoPairBrackets && CLOSERS.includes(ch) && next === ch) {
      ed.setSel({ pos: pos + 1 });
      return true;
    }
    if (close === undefined) return false;
    // Quotes and markers only pair at a word boundary (keeps "don't", snake_case, 2*3).
    if ((ch === '"' || ch === "'" || md) && /[\p{L}\p{N}]/u.test(prev) && !emptyPair) return false;
    if (next && /[\p{L}\p{N}]/u.test(next)) return false;
    ed.replaceRange(pos, pos, ch + close, key, close.length);
    return true;
  };

  const onBeforeInput = (e: InputEvent) => {
    if (inWidget(e.target) || ed.composing || e.isComposing) return;
    const t = e.inputType;
    if (t === 'insertParagraph' || t === 'insertLineBreak') {
      e.preventDefault();
      enter(t === 'insertLineBreak');
      return;
    }
    if (t === 'historyUndo' || t === 'historyRedo') {
      e.preventDefault();
      if (t === 'historyUndo') undo(ed);
      else redo(ed);
      return;
    }
    if (t === 'insertText' || t === 'insertReplacementText' || t.startsWith('delete')) {
      const r = rangeOf(e);
      if (!r) return;
      let text = e.data ?? e.dataTransfer?.getData('text/plain') ?? '';
      if (t.startsWith('delete')) {
        text = '';
        if (r.from === r.to) return; // nothing selected by the browser: structural cases are handled on keydown
      }
      e.preventDefault();
      const key = (t.startsWith('delete') ? 'del:' : 'type:') + (caretBlock()?.id ?? '');
      if (t === 'insertText' && r.from === r.to && text.length === 1 && autoPair(r.from, text, key)) return;
      ed.replaceRange(r.from, r.to, text, key);
      return;
    }
    if (t === 'insertFromPaste' || t === 'insertFromDrop' || t === 'insertFromComposition' || t === 'deleteCompositionText') return;
    if (t.startsWith('format')) e.preventDefault();
  };

  const onInput = (e: Event) => {
    if (inWidget(e.target) || ed.composing) return;
    // Anything the browser changed without us (spellcheck, IME end, unusual input types).
    const b = caretBlock();
    ed.syncFromDom(b?.id ?? null);
  };

  const onCompStart = (e: CompositionEvent) => {
    if (inWidget(e.target)) return;
    const s = ed.readSel();
    if (s && s.anchor !== s.focus) {
      const a = ed.doc.locate(Math.min(s.anchor, s.focus));
      const b = ed.doc.locate(Math.max(s.anchor, s.focus));
      if (a.i !== b.i) ed.replaceRange(Math.min(s.anchor, s.focus), Math.max(s.anchor, s.focus), '', null);
    }
    ed.composing = true;
    ed.hist.break();
  };
  const onCompEnd = (e: CompositionEvent) => {
    if (inWidget(e.target)) return;
    ed.composing = false;
    const b = caretBlock();
    // Let WebKit finish its own input event first.
    setTimeout(() => {
      if (!ed.composing) ed.syncFromDom(b?.id ?? caretBlock()?.id ?? null);
    }, 0);
  };

  /** Mod+Z / Mod+Shift+Z / Mod+Y? */
  const isHistKey = (e: KeyboardEvent) => (e.metaKey || e.ctrlKey) && !e.altKey && /^[zZyY]$/.test(e.key);

  /**
   * Undo/redo inside a widget uses the one document history (every widget edit
   * is recorded there synchronously), not the widget's local history, which
   * goes stale as soon as the document history moves (#55). Capture phase so
   * the widget's own keymap never sees the key.
   */
  const onKeyDownCapture = (e: KeyboardEvent) => {
    if (!inWidget(e.target) || !isHistKey(e) || e.isComposing || e.keyCode === 229) return;
    e.preventDefault();
    e.stopPropagation();
    if (e.key === 'y' || e.key === 'Y' || e.shiftKey) redo(ed);
    else undo(ed);
  };

  const onKeyDown = (e: KeyboardEvent) => {
    const mod = e.metaKey || e.ctrlKey;
    const histKey = isHistKey(e);
    if (inWidget(e.target) || e.isComposing || ed.composing || e.keyCode === 229) return;
    if (histKey) {
      e.preventDefault();
      if (e.key === 'y' || e.key === 'Y' || e.shiftKey) redo(ed);
      else undo(ed);
      return;
    }
    // ⇧⌘V / Ctrl+Shift+V: Paste as Plain Text (#96). The engine's own "paste and match style"
    // would expose only text/plain (= markdown for a Margin copy), so read every flavour ourselves.
    if (mod && e.shiftKey && !e.altKey && e.code === 'KeyV') {
      e.preventDefault();
      pastePlain(ed);
      return;
    }
    if (e.key === 'Enter' && !mod && !e.altKey) {
      e.preventDefault();
      enter(e.shiftKey);
      return;
    }
    if (e.key === 'Backspace' || e.key === 'Delete') {
      if (mod || e.altKey) return;
      const c = caretLeaf();
      if (!c) {
        if (!ed.doc.leaves.length) e.preventDefault();
        return;
      }
      let res: E.Caret | null = null;
      ed.hist.break();
      ed.change(() => (res = e.key === 'Backspace' ? E.backspace(ed.doc, c.i, c.off) : E.del(ed.doc, c.i, c.off)) ?? undefined);
      if (res) e.preventDefault();
      return;
    }
    if (e.key === 'Tab') {
      const c = caretLeaf();
      e.preventDefault();
      if (!c) return;
      ed.change(() => E.indent(ed.doc, c.i, c.off, e.shiftKey) ?? undefined);
      return;
    }
    if (isLineStartKey(e)) setTimeout(skipMarker, 0);
    const edge = docEdgeKey(e);
    if (edge) {
      ed.hist.break();
      if (docEdge(edge)) e.preventDefault();
      return;
    }
    if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.key)) {
      ed.hist.break();
      if (e.shiftKey || mod || e.altKey) return;
      arrowIntoWidget(e);
    }
  };

  /** ⌘↑/⌘↓ (macOS) or Ctrl+Home/End without Shift: document start/end. */
  const docEdgeKey = (e: KeyboardEvent): 'start' | 'end' | null => {
    if (e.shiftKey || e.altKey) return null;
    const mac = /Mac|iPhone|iPad/.test(navigator.platform);
    if (e.ctrlKey && !e.metaKey && (e.key === 'Home' || e.key === 'End')) return e.key === 'Home' ? 'start' : 'end';
    if (mac && e.metaKey && !e.ctrlKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) return e.key === 'ArrowUp' ? 'start' : 'end';
    return null;
  };

  /**
   * Move to the document start/end ourselves: native moves cannot enter a widget
   * (#56) and WebKit lands before a heading's hidden marker (#57).
   */
  const docEdge = (at: 'start' | 'end'): boolean => {
    const n = ed.doc.leaves.length;
    if (!n) return false;
    const i = at === 'start' ? 0 : n - 1;
    const l = ed.doc.leaves[i];
    if (!E.isTextLeaf(l)) ed.setSel({ widget: l.id, at });
    else ed.setSel({ pos: at === 'start' ? ed.doc.docPos(0, metaLen(l)) : ed.doc.docPos(i, leafContent(l).length) });
    return true;
  };

  /** Home / ⌘← without Shift: native line-start move (fixed up by `skipMarker`). */
  const isLineStartKey = (e: KeyboardEvent): boolean => {
    if (e.shiftKey || e.altKey || e.ctrlKey) return false;
    const mac = /Mac|iPhone|iPad/.test(navigator.platform);
    return mac ? e.metaKey && e.key === 'ArrowLeft' : !e.metaKey && e.key === 'Home';
  };

  /** After a native line-start move: a caret inside a heading's leading marker goes past it (#57, WebKit). */
  const skipMarker = () => {
    const c = caretLeaf();
    if (!c) return;
    const l = ed.doc.leaves[c.i];
    const m = metaLen(l);
    if (m && c.off < m) ed.setSel({ pos: ed.doc.docPos(c.i, m) });
  };

  /** Arrow at a text block edge next to a widget → hand the caret to the widget. */
  const arrowIntoWidget = (e: KeyboardEvent) => {
    const c = caretLeaf();
    if (!c) return;
    const back = e.key === 'ArrowUp' || e.key === 'ArrowLeft';
    const j = back ? c.i - 1 : c.i + 1;
    const l = ed.doc.leaves[j];
    if (!l || E.isTextLeaf(l)) return;
    const len = leafContent(ed.doc.leaves[c.i]).length;
    let edge = false;
    if (e.key === 'ArrowLeft') edge = c.off === 0;
    else if (e.key === 'ArrowRight') edge = c.off === len;
    else edge = onEdgeLine(ed, ed.doc.leaves[c.i].id, back);
    if (!edge) return;
    e.preventDefault();
    ed.setSel({ widget: l.id, at: back ? 'end' : 'start' });
  };

  const onMouseDown = (e: MouseEvent) => {
    ed.hist.break();
    const t = e.target as HTMLElement;
    if (t.classList?.contains('md-task-box')) e.preventDefault();
  };

  const onClick = (e: MouseEvent) => {
    const t = e.target as HTMLElement;
    if (t.classList?.contains('md-task-box')) {
      e.preventDefault();
      const b = ed.view.blockOf(t);
      const i = b ? ed.doc.indexOf(b.id) : -1;
      if (i < 0) return;
      // mousedown was prevented, so the editor may not have focus: give it focus
      // and a caret in the task so Cmd+Z / typing work right after the click.
      const focused = document.activeElement === root;
      const id = ed.doc.leaves[i].id;
      ed.change(() => {
        E.toggleTask(ed.doc, i);
        const j = ed.doc.indexOf(id);
        return focused || j < 0 ? undefined : { pos: ed.doc.docPos(j, leafContent(ed.doc.leaves[j]).length) };
      });
      return;
    }
    // footnotes: Cmd/Ctrl+click a reference jumps to its definition, its label jumps back
    const fn = t.closest?.('.md-fnref') as HTMLElement | null;
    if (fn && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      const d = footnoteDef(ed.doc, (fn.dataset.href ?? '').slice(4));
      if (d) ed.setSel({ pos: ed.doc.docPos(d.i, d.off) });
      return;
    }
    if ((e.metaKey || e.ctrlKey) && t.classList?.contains('md-bmeta')) {
      const b = ed.view.blockOf(t);
      const l = b && ed.doc.get(b.id);
      if (l?.type === 'footnote') {
        e.preventDefault();
        const r = footnoteRef(ed.doc, t.textContent!.trim().slice(2, -2));
        if (r) ed.setSel({ pos: ed.doc.docPos(r.i, r.off) });
        return;
      }
    }
    const link = t.closest?.('.md-link') as HTMLElement | null;
    if (link && (e.metaKey || e.ctrlKey) && link.dataset.href !== undefined) {
      e.preventDefault();
      ed.settings.openLink?.(link.dataset.href);
      return;
    }
    if (t === root && ed.doc.leaves.length) {
      const last = root.lastElementChild as HTMLElement | null;
      if (last && e.clientY > last.getBoundingClientRect().bottom) {
        const i = ed.doc.leaves.length - 1;
        if (!E.isTextLeaf(ed.doc.leaves[i])) ed.change(() => E.ensureParagraphAfter(ed.doc, i));
        else ed.setSel({ pos: ed.doc.text().length });
      }
    }
  };

  /** Footnote hover preview: the reference's tooltip shows its definition text. */
  const onMouseOver = (e: MouseEvent) => {
    const fn = (e.target as HTMLElement).closest?.('.md-fnref') as HTMLElement | null;
    if (!fn) return;
    const label = (fn.dataset.href ?? '').slice(4);
    const d = footnoteDef(ed.doc, label);
    fn.title = d ? inlinePlain(parseInline(d.text, ed.doc.refs())).trim() || '(empty footnote)' : `Footnote [^${label}] is not defined`;
    fn.classList.toggle('md-fn-missing', !d);
  };

  const onSelChange = () => {
    if (ed.composing) return;
    const s = getSelection();
    if (!s || !s.rangeCount || !root.contains(s.focusNode)) return;
    const b = ed.view.blockOf(s.focusNode);
    const sel = ed.readSel();
    if (sel) ed.lastSel = sel;
    if (b && b.id !== EMPTY_ID) {
      const i = ed.doc.indexOf(b.id);
      const content = ed.view.content(b.id);
      if (i >= 0 && content && sel) ed.view.setFocus(b.id, ed.doc.locate(sel.focus).off);
      else ed.view.setFocus(b.id, null);
    }
    if (ed.settings.typewriterMode && s.isCollapsed) ed.scrollCaret();
    ed.emitSel();
  };

  const L: [EventTarget, string, EventListener, boolean?][] = [
    [root, 'beforeinput', onBeforeInput as EventListener],
    [root, 'input', onInput],
    [root, 'compositionstart', onCompStart as EventListener],
    [root, 'compositionend', onCompEnd as EventListener],
    [root, 'keydown', onKeyDown as EventListener],
    [root, 'keydown', onKeyDownCapture as EventListener, true],
    [root, 'mousedown', onMouseDown as EventListener],
    [root, 'click', onClick as EventListener],
    [root, 'mouseover', onMouseOver as EventListener],
    [root, 'copy', ((e: ClipboardEvent) => !inWidget(e.target) && onCopy(ed, e, false)) as EventListener],
    [root, 'cut', ((e: ClipboardEvent) => !inWidget(e.target) && onCopy(ed, e, true)) as EventListener],
    [root, 'paste', ((e: ClipboardEvent) => !inWidget(e.target) && onPaste(ed, e)) as EventListener],
    [root, 'drop', ((e: DragEvent) => !inWidget(e.target) && onDrop(ed, e)) as EventListener],
    [document, 'selectionchange', onSelChange],
  ];
  for (const [t, n, f, c] of L) t.addEventListener(n, f, !!c);
  return () => {
    for (const [t, n, f, c] of L) t.removeEventListener(n, f, !!c);
  };
}

/** Is the caret on the first (back) / last visual line of block `id`? */
function onEdgeLine(ed: EditorCore, id: string, top: boolean): boolean {
  const content = ed.view.content(id);
  const s = getSelection();
  if (!content || !s || !s.rangeCount) return false;
  const r = s.getRangeAt(0).getClientRects()[0] ?? s.getRangeAt(0).getBoundingClientRect();
  const box = content.getBoundingClientRect();
  if (!r || (!r.height && !r.top)) return true;
  const lh = parseFloat(getComputedStyle(content).lineHeight) || r.height || 16;
  return top ? r.top - box.top < lh * 0.8 : box.bottom - r.bottom < lh * 0.8;
}

const BRACKETS: Record<string, string> = { '(': ')', '[': ']', '{': '}', '"': '"', "'": "'" };
const CLOSERS = [')', ']', '}', '"', "'"];
const MD_PAIRS = ['*', '_', '`', '~'];
