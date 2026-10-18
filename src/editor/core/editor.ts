/**
 * Editor state and plumbing: Doc + View + History, DOM selection ↔ document
 * positions, the change pipeline (record undo → re-render → place caret →
 * notify). Event handling lives in input.ts, commands in commands.ts.
 */
import { DEFAULT_MARKDOWN_OPTIONS, type EditorSettings, type Heading, type MarkdownOptions } from '../../contracts';
import { Doc, leafContent } from './model';
import { View, EMPTY_ID } from './view';
import { History, type Sel } from './history';
import { isTextLeaf, type Caret, widgetToParagraph, ensureParagraphAfter } from './edit';
import { offsetToPoint, pointToOffset, readText } from './dom';
import { outline } from './query';
import type { Line } from './types';

export const OUTLINE_EVENT = 'margin:outline-changed';

/** Position of content offset `off` in `lines` laid out from `base`. */
export function posIn(lines: Line[], base: number, off: number): number {
  let p = base;
  for (const ln of lines) {
    if (off <= ln.text.length) return p + ln.prefix.length + Math.max(0, off);
    off -= ln.text.length + 1;
    p += ln.prefix.length + ln.text.length + ln.eol.length;
  }
  return p;
}

export class EditorCore {
  readonly doc = new Doc('');
  readonly hist = new History();
  readonly view: View;
  readonly root: HTMLElement;
  changeCbs = new Set<() => void>();
  selCbs = new Set<() => void>();
  composing = false;
  /** Last known caret/selection (document positions). */
  lastSel: Sel = null;
  private outlineSig = '';

  constructor(readonly host: HTMLElement, public settings: EditorSettings) {
    this.root = document.createElement('div');
    this.root.className = 'md-editor';
    this.root.contentEditable = 'true';
    this.root.spellcheck = settings.spellcheck;
    this.root.setAttribute('role', 'textbox');
    this.root.setAttribute('aria-multiline', 'true');
    host.append(this.root);
    this.view = new View(this.root, this.doc, {
      settings: () => this.settings,
      widgetChange: (id, raw) => this.widgetChange(id, raw),
      widgetExit: (id, dir) => this.widgetExit(id, dir),
      widgetRemove: (id) => this.change(() => this.withLeaf(id, (i) => widgetToParagraph(this.doc, i)), null),
      getOutline: () => this.outline(),
      scrollToHeading: (id) => this.scrollToHeading(id),
    });
    this.applyModes();
  }

  outline(): Heading[] {
    return outline(this.doc);
  }

  withLeaf(id: string, fn: (i: number) => Caret | void): Caret | void {
    const i = this.doc.indexOf(id);
    if (i >= 0) return fn(i);
  }

  applyModes(): void {
    this.root.classList.toggle('md-focus-mode', !!this.settings.focusMode);
    this.root.classList.toggle('md-typewriter', !!this.settings.typewriterMode);
    this.root.spellcheck = !!this.settings.spellcheck;
    this.root.dataset.scheme = this.settings.colorScheme;
    // #102 whitespace / display options are pure CSS over the unchanged source.
    const md = this.md();
    this.root.classList.toggle('md-ignore-linebreak', !md.preserveLineBreak);
    this.root.classList.toggle('md-visible-br', md.visibleBr);
    this.root.classList.toggle('md-indent-first', md.indentFirstLine);
    this.root.classList.toggle('md-no-expand-simple', !md.expandSimpleBlock);
  }

  /** Effective Markdown / Editor preferences (#100, #102). */
  md(): MarkdownOptions {
    return { ...DEFAULT_MARKDOWN_OPTIONS, ...this.settings.markdown };
  }

  // ------------------------------------------------------------ selection mapping

  /** Document position of a DOM point inside the root, or null. */
  pointToPos(node: Node, offset: number, end = false): number | null {
    if (node === this.root) {
      const kids = this.root.children;
      if (offset >= kids.length) return this.doc.text().length;
      node = kids[offset];
      offset = 0;
    }
    const b = this.view.blockOf(node);
    if (!b) return null;
    if (b.id === EMPTY_ID) return 0;
    const i = this.doc.indexOf(b.id);
    if (i < 0) return null;
    const l = this.doc.leaves[i];
    const content = this.view.content(b.id);
    if (content && isTextLeaf(l)) {
      let off: number;
      if (content.contains(node) || content === node) off = pointToOffset(content, node, offset);
      else off = node === b.el && offset >= b.el.childNodes.length ? leafContent(l).length : 0;
      return this.doc.docPos(i, off);
    }
    return end ? this.doc.docPos(i, leafContent(l).length) : this.doc.start(i);
  }

  /** Current DOM selection as document positions (null when outside the editor). */
  readSel(): Sel {
    const s = getSelection();
    if (!s || !s.rangeCount || !this.root.contains(s.anchorNode)) return null;
    const a = this.pointToPos(s.anchorNode!, s.anchorOffset);
    const f = this.pointToPos(s.focusNode!, s.focusOffset, true);
    if (a === null || f === null) return null;
    return { anchor: a, focus: f };
  }

  /** Selection, falling back to the last known one. */
  sel(): { from: number; to: number } {
    const s = this.readSel() ?? this.lastSel ?? { anchor: 0, focus: 0 };
    return { from: Math.min(s.anchor, s.focus), to: Math.max(s.anchor, s.focus) };
  }

  private domPoint(pos: number): { node: Node; offset: number; id: string; off: number } | null {
    if (!this.doc.leaves.length) {
      const c = this.view.content(EMPTY_ID);
      return c ? { node: c, offset: 0, id: EMPTY_ID, off: 0 } : null;
    }
    const { i, off } = this.doc.locate(pos);
    const l = this.doc.leaves[i];
    const content = l && this.view.content(l.id);
    if (!content || !isTextLeaf(l)) return null;
    return { ...offsetToPoint(content, off), id: l.id, off };
  }

  /** Put the DOM selection at document positions (text blocks), or focus a widget. */
  setSel(sel: Sel | Caret | undefined | void, scroll = true): void {
    if (!sel) return;
    if ('widget' in sel) {
      this.view.setFocus(sel.widget, null);
      this.view.widget(sel.widget)?.focus(sel.at);
      return;
    }
    const s: { anchor: number; focus: number } = 'pos' in sel ? { anchor: sel.pos, focus: sel.pos } : sel;
    const fp = this.domPoint(s.focus);
    if (fp) this.view.setFocus(fp.id, fp.off);
    else {
      const { i } = this.doc.locate(s.focus);
      const l = this.doc.leaves[i];
      if (l && !isTextLeaf(l)) return this.setSel({ widget: l.id, at: 'start' }, scroll);
    }
    const f = fp && this.domPoint(s.focus);
    const a = s.anchor === s.focus ? f : this.domPoint(s.anchor);
    if (!a || !f) return;
    if (document.activeElement !== this.root) this.root.focus({ preventScroll: true });
    const ds = getSelection()!;
    try {
      ds.setBaseAndExtent(a.node, a.offset, f.node, f.offset);
    } catch {
      return;
    }
    this.lastSel = { anchor: s.anchor, focus: s.focus };
    if (scroll) this.scrollCaret();
  }

  scrollCaret(): void {
    const s = getSelection();
    if (!s || !s.rangeCount) return;
    const r = s.getRangeAt(0).getBoundingClientRect();
    const el = s.focusNode && (s.focusNode.nodeType === 1 ? (s.focusNode as Element) : s.focusNode.parentElement);
    if (!r.height && el) el.scrollIntoView({ block: 'nearest' });
    else if (r.height) {
      const sc = scrollParent(this.root);
      const box = sc === document.scrollingElement ? { top: 0, bottom: innerHeight } : sc.getBoundingClientRect();
      if (this.settings.typewriterMode) sc.scrollTop += r.top - (box.top + box.bottom) / 2;
      else if (r.bottom > box.bottom) sc.scrollTop += r.bottom - box.bottom + 8;
      else if (r.top < box.top) sc.scrollTop -= box.top - r.top + 8;
    }
  }

  // ------------------------------------------------------------ change pipeline

  /** Run an edit, record undo, re-render, place caret (when returned) and notify. */
  change(fn: () => Caret | Sel | void, key: string | null = null): void {
    const before = this.doc.text();
    const selB = this.readSel() ?? this.lastSel;
    this.doc.takeEdits();
    const caret = fn();
    const edits = this.doc.takeEdits();
    // A single in-place leaf edit (typing) gives the diff region directly: no O(document) work.
    const hint = edits && edits.length === 1 ? edits[0] : undefined;
    const after = this.doc.text();
    this.view.sync();
    if (caret) this.setSel(caret);
    const selA = this.readSel() ?? (caret && 'pos' in caret ? { anchor: caret.pos, focus: caret.pos } : selB);
    if (edits ? edits.every((e) => e.before === e.after) : before === after) return;
    this.hist.record(before, after, selB, selA, key, Date.now(), hint);
    this.emitChange();
  }

  private outlineRev = -1;

  emitChange(): void {
    for (const cb of this.changeCbs) cb();
    if (this.doc.outlineRev === this.outlineRev) return;
    this.outlineRev = this.doc.outlineRev;
    const sig = JSON.stringify(this.outline());
    if (sig !== this.outlineSig) {
      this.outlineSig = sig;
      document.dispatchEvent(new CustomEvent(OUTLINE_EVENT));
    }
  }

  emitSel(): void {
    for (const cb of this.selCbs) cb();
  }

  /** Read the text of block `id` from the DOM into the model (browser-made edits, IME). */
  syncFromDom(id: string | null): void {
    if (!id) return;
    const content = this.view.content(id);
    if (!content) return;
    const text = readText(content);
    const s = getSelection();
    const off = s && s.rangeCount && content.contains(s.focusNode) ? pointToOffset(content, s.focusNode!, s.focusOffset) : text.length;
    if (id === EMPTY_ID) {
      if (!text) return;
      this.change(() => {
        this.doc.replace(0, 0, text);
        return { pos: off };
      }, 'type');
      return;
    }
    const i = this.doc.indexOf(id);
    if (i < 0 || leafContent(this.doc.leaves[i]) === text) return;
    this.change(() => {
      const l = this.doc.leaves[i];
      const base = this.doc.start(i);
      this.doc.setContent(i, text);
      return { pos: posIn(l.lines, base, off) };
    }, 'type:' + id);
  }

  /** Replace document range with text (one text leaf → local edit, else re-parse). */
  /** Replace [from, to) with `text`; the caret ends `back` characters before the end of the inserted text. */
  replaceRange(from: number, to: number, text: string, key: string | null, back = 0): void {
    this.change(() => {
      if (!this.doc.leaves.length) {
        this.doc.replace(0, 0, text);
        return { pos: text.length };
      }
      const a = this.doc.locate(from);
      const b = this.doc.locate(to);
      const l = this.doc.leaves[a.i];
      if (a.i === b.i && isTextLeaf(l) && this.doc.docPos(a.i, a.off) === from && this.doc.docPos(b.i, b.off) === to && !text.includes('\n')) {
        const c = leafContent(l);
        const base = this.doc.start(a.i);
        this.doc.setContent(a.i, c.slice(0, a.off) + text + c.slice(b.off));
        return { pos: posIn(l.lines, base, a.off + text.length - back) };
      }
      this.doc.replace(from, to, text);
      return { pos: from + text.length - back };
    }, key);
  }

  private widgetChange(id: string, raw: string): void {
    if (!raw.trim()) {
      this.change(() => this.withLeaf(id, (i) => widgetToParagraph(this.doc, i)), null);
      return;
    }
    this.change(() => {
      this.withLeaf(id, (i) => void this.doc.setWidgetRaw(i, raw));
    }, 'w:' + id);
  }

  widgetExit(id: string, dir: 'up' | 'down' | 'left' | 'right'): void {
    const i = this.doc.indexOf(id);
    if (i < 0) return;
    const back = dir === 'up' || dir === 'left';
    const j = back ? i - 1 : i + 1;
    const l = this.doc.leaves[j];
    if (!l) {
      if (back) return;
      this.change(() => ensureParagraphAfter(this.doc, i), null);
      return;
    }
    this.root.focus({ preventScroll: true });
    if (!isTextLeaf(l)) this.setSel({ widget: l.id, at: back ? 'end' : 'start' });
    else this.setSel({ pos: back ? this.doc.docPos(j, leafContent(l).length) : this.doc.docPos(j, 0) });
  }

  scrollToHeading(id: string): void {
    const el = this.view.recs.get(id)?.el;
    if (el) el.scrollIntoView({ block: 'start' });
  }
}

export function scrollParent(el: HTMLElement): HTMLElement {
  for (let p = el.parentElement; p; p = p.parentElement) {
    const o = getComputedStyle(p).overflowY;
    if ((o === 'auto' || o === 'scroll') && p.scrollHeight > p.clientHeight) return p;
  }
  return (document.scrollingElement as HTMLElement) ?? document.documentElement;
}
