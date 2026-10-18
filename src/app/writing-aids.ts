import type { EditorHandle } from '../contracts';
import { h, clearChildren } from './util/dom';
import { smartReplace, type SmartOpts } from './smart-punct';
import { emojiCandidates } from './emoji-data';

export interface AidsHost {
  /** The editor host element (contenteditable lives inside). */
  root: HTMLElement;
  editor(): EditorHandle;
  smart(): SmartOpts;
}

/** Places where substitutions and emoji completion never apply. */
const RAW_CONTEXT = 'code, pre, kbd, samp, .cm-editor, .md-meta, .katex, .md-math, [data-type="code"], [data-type="math"], [data-type="html"], [data-type="front_matter"]';

/** Text before the caret inside its text node, when the selection is a caret in rich text. */
function caretContext(root: HTMLElement): { before: string; node: Text } | null {
  const sel = window.getSelection();
  if (!sel || !sel.isCollapsed || !sel.anchorNode || !root.contains(sel.anchorNode)) return null;
  const node = sel.anchorNode;
  if (node.nodeType !== Node.TEXT_NODE) return null;
  if (node.parentElement?.closest(RAW_CONTEXT)) return null;
  return { before: (node as Text).data.slice(0, sel.anchorOffset), node: node as Text };
}

/** Replace the `del` characters before the caret with `text` as one editor edit. */
function replaceBefore(ed: EditorHandle, del: number, text: string): void {
  const sel = window.getSelection() as Selection & { modify?(a: string, d: string, g: string): void };
  for (let i = 0; i < del; i++) sel.modify?.('extend', 'backward', 'character');
  ed.exec({ kind: 'insertText', text });
}

/** Smart quotes / dashes on input (Edit › Substitutions). */
export function installSmartPunctuation(host: AidsHost): void {
  host.root.addEventListener(
    'beforeinput',
    (e) => {
      if (e.inputType !== 'insertText' || !e.data || e.data.length !== 1 || e.isComposing) return;
      const o = host.smart();
      if (!o.quotes && !o.dashes) return;
      const ctx = caretContext(host.root);
      if (!ctx) return;
      const edit = smartReplace(ctx.before, e.data, o);
      if (!edit) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      replaceBefore(host.editor(), edit.del, edit.text);
    },
    true,
  );
}

/**
 * `:emoji:` autocomplete (fe-preferences §10): `:` + at least one word character
 * opens a popup of shortcodes; accepting inserts the `:name:` text.
 */
export class EmojiComplete {
  readonly el: HTMLElement;
  private items: [string, string][] = [];
  private index = 0;
  private typed = '';

  constructor(private host: AidsHost) {
    this.el = h('div.emoji-popup', { role: 'listbox', 'aria-label': 'Emoji', hidden: true });
    host.root.addEventListener('input', () => this.update());
    host.root.addEventListener('keydown', (e) => this.onKey(e), true);
    host.root.addEventListener('blur', () => this.hide(), true);
  }

  get open(): boolean {
    return !this.el.hidden;
  }

  hide(): void {
    this.el.hidden = true;
    this.items = [];
  }

  private update(): void {
    const ctx = caretContext(this.host.root);
    const m = ctx && /(?:^|[\s(（]):([A-Za-z0-9_+-]+)$/.exec(ctx.before);
    const list = m ? emojiCandidates(m[1]) : [];
    if (!m || !list.length) return this.hide();
    this.typed = m[1];
    this.items = list;
    this.index = 0;
    this.render();
    const r = window.getSelection()!.getRangeAt(0).getBoundingClientRect();
    this.el.hidden = false;
    this.el.style.left = `${Math.max(4, Math.min(r.left, window.innerWidth - this.el.offsetWidth - 4))}px`;
    this.el.style.top = `${r.bottom + 4}px`;
  }

  private render(): void {
    clearChildren(this.el);
    this.items.forEach(([name, emoji], i) => {
      const row = h('div.emoji-item', { role: 'option', 'aria-selected': String(i === this.index), 'data-name': name }, h('span.emoji-char', { text: emoji }), h('span.emoji-name', { text: `:${name}:` }));
      row.addEventListener('mousedown', (e) => {
        e.preventDefault();
        this.index = i;
        this.accept();
      });
      this.el.appendChild(row);
    });
  }

  private onKey(e: KeyboardEvent): void {
    if (!this.open) return;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      this.index = (this.index + (e.key === 'ArrowDown' ? 1 : -1) + this.items.length) % this.items.length;
      this.render();
    } else if (e.key === 'Enter' || e.key === 'Tab') this.accept();
    else if (e.key === 'Escape') this.hide();
    else return;
    e.preventDefault();
    e.stopImmediatePropagation();
  }

  private accept(): void {
    const it = this.items[this.index];
    if (!it) return;
    this.hide();
    replaceBefore(this.host.editor(), this.typed.length + 1, `:${it[0]}:`);
  }
}

/** Edit › Speech: read the selection, or the whole document, with the system voice. */
export function startSpeaking(root: HTMLElement): boolean {
  const synth = (globalThis as { speechSynthesis?: SpeechSynthesis }).speechSynthesis;
  if (!synth || typeof SpeechSynthesisUtterance === 'undefined') return false;
  const sel = window.getSelection();
  const picked = sel && !sel.isCollapsed && sel.anchorNode && root.contains(sel.anchorNode) ? sel.toString() : '';
  const text = (picked || root.innerText).trim();
  synth.cancel(); // a second Start replaces the first, no queueing
  if (text) synth.speak(new SpeechSynthesisUtterance(text));
  return true;
}

export function stopSpeaking(): void {
  (globalThis as { speechSynthesis?: SpeechSynthesis }).speechSynthesis?.cancel();
}
