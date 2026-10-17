/**
 * Block-level renderer: keeps one DOM element per leaf (keyed by `data-bid`)
 * inside the contenteditable root, re-rendering only leaves whose source or
 * container context changed. Text leaves get an editable `.md-content`;
 * widget leaves are mounted from the registry into a non-editable host.
 */
import type { EditorSettings, Heading, WidgetBlockType, WidgetContext, WidgetInstance } from '../../contracts';
import { Doc, leafContent, leafRaw, widgetRaw } from './model';
import type { Leaf } from './types';
import { isTextLeaf } from './edit';
import { registry, routeFence } from './registry';
import { renderContent, expandAt, type InlineCtx } from './render-inline';
import { fallbackWidget } from './fallback';

export const EMPTY_ID = '_empty';

export interface ViewCallbacks {
  settings(): EditorSettings;
  widgetChange(id: string, raw: string): void;
  widgetExit(id: string, dir: 'up' | 'down' | 'left' | 'right'): void;
  widgetRemove(id: string): void;
  getOutline(): Heading[];
  scrollToHeading(id: string): void;
}

interface Rec {
  el: HTMLElement;
  sig: string;
  /** Leaf state the signature was computed from (identity check skips unchanged leaves). */
  seen?: { lines: Leaf['lines']; chain: Leaf['chain']; type: string; level?: number; lang?: string; openFrom: number };
  content?: HTMLElement;
  wtype?: WidgetBlockType;
  inst?: WidgetInstance;
  ctx?: WidgetContext;
}

export function widgetType(l: Leaf): WidgetBlockType {
  return l.type === 'code_fence' || l.type === 'diagram' ? routeFence(l.lang) : (l.type as WidgetBlockType);
}

function chainSig(l: Leaf): string {
  return (
    l.chain.map((c) => (c.kind === 'quote' ? 'q' : `i${c.ordered ? c.number : ''}${c.delim}${c.task ?? ''}${c.width}`)).join(',') +
    '|' +
    l.openFrom
  );
}

export class View {
  readonly recs = new Map<string, Rec>();
  focusId: string | null = null;
  private refsSig = '';
  private refsObj: unknown = null;

  constructor(readonly root: HTMLElement, readonly doc: Doc, private cb: ViewCallbacks) {}

  inlineCtx(): InlineCtx {
    const s = this.cb.settings();
    return { refs: this.doc.refs(), resolveAsset: (src) => s.resolveAsset(src), inlineMath: registry.inlineMath };
  }

  /** Bring the DOM in line with the document. Returns ids of re-rendered text leaves. */
  sync(force = false): Set<string> {
    const changed = new Set<string>();
    const refs = this.doc.refs();
    let refsChanged = false;
    if (refs !== this.refsObj) {
      this.refsObj = refs;
      const rs = JSON.stringify([...refs]);
      refsChanged = rs !== this.refsSig;
      this.refsSig = rs;
    }
    const ictx = this.inlineCtx();
    const seen = new Set<string>();
    let prev: Element | null = null;
    const leaves = this.doc.leaves.length ? this.doc.leaves : [this.emptyLeaf()];
    for (const l of leaves) {
      seen.add(l.id);
      let rec = this.recs.get(l.id);
      const sn = rec?.seen;
      if (rec && sn && !force && !refsChanged && sn.lines === l.lines && sn.chain === l.chain && sn.type === l.type && sn.level === l.level && sn.lang === l.lang && sn.openFrom === l.openFrom) {
        // untouched leaf: only make sure it sits at the right place
        const want: Element | null = prev ? prev.nextElementSibling : this.root.firstElementChild;
        if (want !== rec.el) this.root.insertBefore(rec.el, want);
        prev = rec.el;
        continue;
      }
      const text = isTextLeaf(l);
      const wt = text ? undefined : widgetType(l);
      const sig = l.type + (l.level ?? '') + (wt ?? '') + '\0' + chainSig(l) + '\0' + leafRaw(l);
      if (rec && (!!rec.content !== text || rec.wtype !== wt)) {
        this.drop(l.id);
        rec = undefined;
      }
      if (!rec) {
        rec = text ? this.createText(l) : this.createWidget(l, wt!);
        this.recs.set(l.id, rec);
        rec.sig = '';
      }
      if (rec.sig !== sig || force || (text && refsChanged)) {
        this.decorate(rec.el, l, wt);
        if (rec.content) {
          renderContent(rec.content, l, leafContent(l), ictx);
          changed.add(l.id);
        } else if (rec.inst && rec.ctx) {
          const raw = widgetRaw(l);
          if (raw !== rec.ctx.raw) {
            rec.ctx.raw = raw;
            rec.inst.update(raw);
          }
        }
        rec.sig = sig;
      }
      rec.seen = { lines: l.lines, chain: l.chain, type: l.type, level: l.level, lang: l.lang, openFrom: l.openFrom };
      const want: Element | null = prev ? prev.nextElementSibling : this.root.firstElementChild;
      if (want !== rec.el) this.root.insertBefore(rec.el, want);
      prev = rec.el;
    }
    for (const id of [...this.recs.keys()]) if (!seen.has(id)) this.drop(id);
    // stray nodes (browser-inserted) after the last block
    while (prev && prev.nextSibling) prev.nextSibling.remove();
    if (this.focusId && !this.recs.has(this.focusId)) this.focusId = null;
    return changed;
  }

  private emptyLeaf(): Leaf {
    return { id: EMPTY_ID, type: 'paragraph', lines: [{ prefix: '', text: '', eol: '' }], n: 1, chain: [], openFrom: 0 };
  }

  private drop(id: string): void {
    const r = this.recs.get(id);
    if (!r) return;
    try {
      r.inst?.destroy();
    } catch (e) {
      console.error(e);
    }
    r.el.remove();
    this.recs.delete(id);
  }

  private createText(l: Leaf): Rec {
    const el = document.createElement('div');
    el.dataset.bid = l.id;
    const content = document.createElement('div');
    content.className = 'md-content';
    el.append(content);
    return { el, sig: '', content };
  }

  private createWidget(l: Leaf, wt: WidgetBlockType): Rec {
    const el = document.createElement('div');
    el.dataset.bid = l.id;
    el.contentEditable = 'false';
    const host = document.createElement('div');
    host.className = 'md-widget-host';
    el.append(host);
    const id = l.id;
    const cb = this.cb;
    const ctx: WidgetContext = {
      raw: widgetRaw(l),
      settings: cb.settings(),
      onChange: (raw) => {
        ctx.raw = raw;
        cb.widgetChange(id, raw);
      },
      onExit: (dir) => cb.widgetExit(id, dir),
      onRemove: () => cb.widgetRemove(id),
      getOutline: () => cb.getOutline(),
      scrollToHeading: (h) => cb.scrollToHeading(h),
    };
    const w = registry.widgets.get(wt) ?? fallbackWidget(wt);
    let inst: WidgetInstance;
    try {
      inst = w.mount(host, ctx);
    } catch (e) {
      console.error('[margin] widget mount failed', wt, e);
      host.textContent = '';
      inst = fallbackWidget(wt).mount(host, ctx);
    }
    return { el, sig: '', wtype: wt, inst, ctx };
  }

  /** Block classes, container indentation, quote bars and list gutter. */
  private decorate(el: HTMLElement, l: Leaf, wt?: WidgetBlockType): void {
    el.className = 'md-block md-' + l.type + (l.level ? ' md-h' + l.level : '') + (wt ? ' md-widget' : '');
    if (l.id === this.focusId) el.classList.add('md-focus');
    el.dataset.type = wt ?? l.type;
    for (const x of [...el.children]) if (x.classList.contains('md-deco')) x.remove();
    let indent = 0;
    const deco: HTMLElement[] = [];
    l.chain.forEach((c, k) => {
      if (c.kind === 'quote') {
        const bar = document.createElement('span');
        bar.className = 'md-deco md-qbar';
        bar.style.left = indent + 'em';
        deco.push(bar);
        indent += 1.1;
        return;
      }
      indent += c.ordered ? Math.max(1.8, String(c.number).length * 0.6 + 1.1) : 1.6;
      if (k < l.openFrom) return;
      if (k !== l.chain.length - 1 && l.chain[k + 1]?.kind === 'item' && k + 1 >= l.openFrom) return;
      const g = document.createElement('span');
      g.className = 'md-deco md-gutter' + (c.task !== null ? ' md-task' : '');
      g.contentEditable = 'false';
      g.style.left = indent + 'em';
      if (c.task !== null) {
        const box = document.createElement('input');
        box.type = 'checkbox';
        box.className = 'md-task-box';
        box.checked = c.task !== ' ';
        box.tabIndex = -1;
        g.append(box);
        el.classList.add(c.task !== ' ' ? 'md-task-done' : 'md-task-open');
      } else g.textContent = c.ordered ? `${c.number}${c.delim}` : '•';
      deco.push(g);
    });
    el.style.setProperty('--indent', indent + 'em');
    el.classList.toggle('md-in-quote', l.chain.some((c) => c.kind === 'quote'));
    el.classList.toggle('md-in-list', l.chain.some((c) => c.kind === 'item'));
    el.prepend(...deco);
  }

  content(id: string): HTMLElement | null {
    return this.recs.get(id)?.content ?? null;
  }

  widget(id: string): WidgetInstance | undefined {
    return this.recs.get(id)?.inst;
  }

  /** Block element + id containing `node`. */
  blockOf(node: Node | null): { id: string; el: HTMLElement } | null {
    let n: Node | null = node;
    while (n && n !== this.root) {
      if (n.nodeType === 1 && (n as HTMLElement).dataset.bid && n.parentNode === this.root)
        return { id: (n as HTMLElement).dataset.bid!, el: n as HTMLElement };
      n = n.parentNode;
    }
    return null;
  }

  /** Mark the caret block (`md-focus`) and expand inline wraps at `off`. */
  setFocus(id: string | null, off: number | null): void {
    if (this.focusId !== id) {
      const old = this.focusId && this.recs.get(this.focusId);
      if (old) {
        old.el.classList.remove('md-focus');
        if (old.content) expandAt(old.content, null);
      }
      this.focusId = id;
      this.recs.get(id ?? '')?.el.classList.add('md-focus');
    }
    const r = id ? this.recs.get(id) : undefined;
    if (r?.content) expandAt(r.content, off);
  }

  updateSettings(s: EditorSettings): void {
    for (const r of this.recs.values()) {
      if (r.ctx) r.ctx.settings = s;
      r.inst?.updateSettings?.(s);
    }
  }

  destroy(): void {
    for (const id of [...this.recs.keys()]) this.drop(id);
  }
}
