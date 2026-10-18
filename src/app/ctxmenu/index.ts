/**
 * Editor context menu controller (#97). On right-click inside the document (or
 * a text field) it computes the target (targets.ts), moves the selection onto
 * the clicked block / inline object when the click lies outside the current
 * selection (like WebKit does for text), and shows the in-app menu. The
 * selection and focus captured here are re-applied before every action, since
 * the menu itself takes focus.
 */
import type { EditorCommand, EditorHandle, Platform } from '../../contracts';
import type { CommandId } from '../commands';
import { extras } from '../platform-extras';
import { confirmDialog } from '../ui/modal';
import { closeContextMenu, showContextMenu } from '../ui/contextmenu';
import { localImages } from '../upload';
import { basename } from '../util/path';
import { buildItems, type CtxActions, type ImageCtxOps, type TableAction } from './items';
import { saveMathAs } from './mathimg';
import { contextTarget, type CtxTarget } from './targets';
import { copySvgAsPng, svgSource } from './svg';

export interface CtxHost {
  editor(): EditorHandle;
  platform: Platform;
  run(id: CommandId): unknown;
  openLink(href: string): void;
  baseDir(): string | null;
  notify(m: string, k: 'info' | 'error' | 'success'): void;
  uploadImage?(src: string): void;
  imageOps?(t: CtxTarget): ImageCtxOps | null;
  saveVideoAs?(src: string): void;
  /** #154: true when the image storage target is an uploader (Upload Image leads the menu). */
 imageUploadFirst?(): boolean;
 /** Check-mark state for the WebKit-native submenu items (spell:/subst:). */
 menuChecks?(id: CommandId): boolean | undefined;
}

const TABLE_BUTTONS: Record<TableAction, string> = {
  rowAbove: '.mb-row-above',
  rowBelow: '.mb-row-below',
  colBefore: '.mb-col-left',
  colAfter: '.mb-col-right',
  deleteRow: '.mb-row-del',
  deleteCol: '.mb-col-del',
  deleteTable: '.mb-table-del',
};



type CaretDoc = Document & {
  caretRangeFromPoint?(x: number, y: number): Range | null;
  caretPositionFromPoint?(x: number, y: number): { offsetNode: Node; offset: number } | null;
};

function rangeAtPoint(x: number, y: number): Range | null {
  const d = document as CaretDoc;
  if (d.caretPositionFromPoint) {
    const p = d.caretPositionFromPoint(x, y);
    if (!p) return null;
    const r = document.createRange();
    r.setStart(p.offsetNode, p.offset);
    return r;
  }
  return d.caretRangeFromPoint?.(x, y) ?? null;
}

/** Put `text` on the clipboard from a user gesture (copy event first, async API as fallback). */
async function writeText(text: string): Promise<boolean> {
  let done = false;
  const h = (e: ClipboardEvent) => {
    if (!e.clipboardData) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    e.clipboardData.setData('text/plain', text);
    done = true;
  };
  document.addEventListener('copy', h, { capture: true });
  try {
    document.execCommand('copy');
  } catch {
    /* refused */
  } finally {
    document.removeEventListener('copy', h, { capture: true });
  }
  if (done) return true;
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

const isField = (el: Element | null): el is HTMLInputElement | HTMLTextAreaElement =>
  el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement;

export class EditorContextMenu {
  private range: Range | null = null;
  private focusEl: HTMLElement | null = null;
  private target: CtxTarget | null = null;
  /** Selection when the right button went down (null = none); undefined = no press seen (keyboard menu). */
  private pressed: Range | null | undefined = undefined;

  constructor(private host: CtxHost, private editorHost: HTMLElement) {}

  /** Listen for right-clicks on the document. Returns a detach function. */
  attach(): () => void {
    const on = (e: MouseEvent) => this.onContextMenu(e);
    // Remember the selection before a right-button press can collapse it (the
    // core / engine may move the caret on mousedown), and keep the press from
    // moving it at all inside the document: placeSelection() decides instead.
    const down = (e: MouseEvent) => {
      if (e.button !== 2) return;
      const sel = getSelection();
      this.pressed = sel && sel.rangeCount ? sel.getRangeAt(0).cloneRange() : null;
      const root = this.root();
      if (root?.contains(e.target as Node) && !this.host.editor().isSourceMode()) e.preventDefault();
    };
    document.addEventListener('mousedown', down, true);
    document.addEventListener('contextmenu', on);
    return () => {
      document.removeEventListener('mousedown', down, true);
      document.removeEventListener('contextmenu', on);
    };
  }

  private root(): HTMLElement | null {
    return this.editorHost.querySelector<HTMLElement>('.md-editor');
  }

  onContextMenu(e: MouseEvent): void {
    if (e.defaultPrevented) return;
    const ed = this.host.editor();
    const source = ed.isSourceMode() ? this.editorHost.querySelector<HTMLElement>('.md-source-host') : null;
    const t = contextTarget(
      e.target,
      ed.isSourceMode() ? null : this.root(),
      source,
      { x: e.clientX, y: e.clientY },
      { uploadFirst: !!this.host.imageUploadFirst?.() },
    );
    if (t.kind === 'none') return;
    e.preventDefault();
    this.target = t;
    if (t.kind !== 'input') this.placeSelection(t, e);
    this.capture();
    const selection = this.selectedText();
    showContextMenu(e.clientX, e.clientY, buildItems(t, { selection }, this.actions(t)));
  }

  private selectedText(): string {
    const f = this.focusEl;
    if (isField(f)) return f.value.slice(f.selectionStart ?? 0, f.selectionEnd ?? 0);
    return this.range && !this.range.collapsed ? this.range.toString() : '';
  }

  /** Move the selection onto the clicked object unless the click is inside the current selection. */
  private placeSelection(t: CtxTarget, e: MouseEvent): void {
    const sel = getSelection();
    // Judge by the selection before the button went down: engines differ in what a
    // right-press does (WebKit selects the word under the pointer, Chromium may collapse).
    const pre = this.pressed;
    this.pressed = undefined;
    const cur = pre !== undefined ? pre : sel && sel.rangeCount ? sel.getRangeAt(0) : null;
    if (sel && pre !== undefined) {
      sel.removeAllRanges();
      if (pre) sel.addRange(pre);
    }
    const inside = (n: Node | null) => !!(n && cur && !cur.collapsed && cur.intersectsNode(n));
    let r: Range | null = null;
    const wrap = t.imageWrap ?? t.math;
    if (wrap) {
      if (inside(wrap)) return;
      // caret inside the object's source (Typora acts on the clicked element, not a selection)
      const src = wrap.querySelector('.md-src')?.firstChild;
      r = document.createRange();
      if (src) r.setStart(src, Math.min(1, src.textContent?.length ?? 0));
      else r.setStartBefore(wrap);
    } else if (t.kind === 'text' || t.kind === 'link') {
      const hit = rangeAtPoint(e.clientX, e.clientY);
      const inRects = (rg: Range) => [...rg.getClientRects()].some((b) => e.clientX >= b.left - 1 && e.clientX <= b.right + 1 && e.clientY >= b.top - 1 && e.clientY <= b.bottom + 1);
      if (cur && !cur.collapsed && ((hit && cur.isPointInRange(hit.startContainer, hit.startOffset)) || inRects(cur))) return;
      r = hit;
    } else if (t.block) {
      if (cur && t.block.contains(cur.startContainer)) return;
      if (t.cell) {
        t.cell.focus({ preventScroll: true });
        return;
      }
      r = document.createRange();
      r.setStart(t.block, 0);
    }
    if (!r || !sel) return;
    const root = this.root();
    if (root && !root.contains(document.activeElement)) root.focus({ preventScroll: true });
    sel.removeAllRanges();
    sel.addRange(r);
  }

  private capture(): void {
    const a = document.activeElement;
    this.focusEl = a instanceof HTMLElement && a !== document.body ? a : this.root();
    const sel = getSelection();
    this.range = sel && sel.rangeCount ? sel.getRangeAt(0).cloneRange() : null;
  }

  restore(): void {
    const f = this.focusEl;
    if (f && document.activeElement !== f) f.focus({ preventScroll: true });
    if (isField(f) || !this.range) return;
    const sel = getSelection();
    sel?.removeAllRanges();
    sel?.addRange(this.range);
  }

  private exec(cmd: EditorCommand): boolean {
    return this.host.editor().exec(cmd);
  }

  async paste(): Promise<void> {
    this.restore();
    let ok = false;
    try {
      ok = document.execCommand('paste');
    } catch {
      ok = false;
    }
    if (ok) return;
    let plain = '';
    let html = '';
    try {
      const snap = await this.host.platform.readClipboard?.();
      if (snap) {
        plain = snap.plain ?? '';
        html = snap.html ?? snap.rtfHtml ?? '';
      } else if (navigator.clipboard?.read) {
        for (const item of await navigator.clipboard.read()) {
          if (item.types.includes('text/html')) html ||= await (await item.getType('text/html')).text();
          if (item.types.includes('text/plain')) plain ||= await (await item.getType('text/plain')).text();
        }
      } else plain = (await navigator.clipboard?.readText?.()) ?? '';
    } catch {
      try {
        plain = (await navigator.clipboard?.readText?.()) ?? '';
      } catch {
        plain = '';
      }
    }
    if (!plain && !html) return this.host.notify('Paste is not available here — use ⌘V.', 'info');
    this.restore();
    const f = this.focusEl;
    if (isField(f)) {
      document.execCommand('insertText', false, plain);
      return;
    }
    const dt = new DataTransfer();
    if (plain) dt.setData('text/plain', plain);
    if (html) dt.setData('text/html', html);
    const target = f && this.editorHost.contains(f) ? f : (this.root() ?? this.editorHost);
    target.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
  }

  private imagePath(src: string): string | null {
    return localImages([{ raw: '', index: 0, src, srcOffset: 0 }], this.host.baseDir())[0]?.path ?? null;
  }

  private async deleteImage(withFile: boolean): Promise<void> {
    const src = this.target?.src ?? '';
    const path = withFile ? this.imagePath(src) : null;
    if (withFile && path) {
      const ok = await confirmDialog(`Delete “${basename(path)}”?`, 'The image file is moved to the Trash and removed from the document.', 'Delete', true);
      if (!ok) return;
    }
    this.restore();
    const wrap = this.target?.imageWrap;
    if (wrap?.isConnected) {
      const r = document.createRange();
      r.setStartBefore(wrap);
      r.setEndAfter(wrap);
      getSelection()?.removeAllRanges();
      getSelection()?.addRange(r);
    }
    if (!this.exec({ kind: 'delete', scope: 'range' })) return;
    if (path) {
      try {
        await extras(this.host.platform).remove?.(path);
      } catch (e) {
        this.host.notify(`Could not delete ${basename(path)}: ${String(e)}`, 'error');
      }
    }
  }


  private tableAction(a: TableAction): void {
    const block = this.target?.block;
    if (!block) return;
    const cell = this.target?.cell ?? block.querySelector<HTMLElement>('.mb-cell');
    if (a !== 'deleteTable') cell?.focus({ preventScroll: true });
    block.querySelector<HTMLButtonElement>(TABLE_BUTTONS[a])?.click();
  }

  private actions(t: CtxTarget): CtxActions {
    const p = this.host.platform;
    const svg = () => t.block?.querySelector('svg') ?? null;
    const ops = this.host.imageOps?.(t) ?? null;
    return {
      run: (id) => void this.host.run(id),
      exec: (cmd) => this.exec(cmd),
      restore: () => this.restore(),
      cut: () => (this.restore(), document.execCommand('cut')),
      copy: () => (this.restore(), document.execCommand('copy')),
      paste: () => void this.paste(),
      writeText: (text) => void writeText(text).then((ok) => ok || this.host.notify('Could not write to the clipboard.', 'error')),
      openLink: (href) => this.host.openLink(href),
      openExternal: (url) => void p.openExternal(url),
      lookup: (word) => void p.openExternal('dict://' + encodeURIComponent(word)),
      checks: (id) => this.host.menuChecks?.(id),
      revealImage: extras(p).revealInFolder
        ? (src) => {
            const path = this.imagePath(src);
            if (path) void extras(p).revealInFolder!(path);
            else this.host.notify('The image is not a local file.', 'info');
          }
        : undefined,
      uploadImage: this.host.uploadImage,
      deleteImage: (withFile) => (ops ? ops.remove(withFile) : void this.deleteImage(withFile)),
      copyImageTo: (_src, move) => ops?.copyTo(move),
      imageTarget: () => ops?.target() ?? null,
      zoomChoices: () => ops?.zoom() ?? null,
      syntaxState: () => ops?.syntax() ?? null,
      saveImageAs: ops ? () => ops.saveAs() : undefined,
      saveMathAs: () => {
        const el = t.block?.querySelector('.katex') ?? t.math?.querySelector('.katex');
        if (!el) return this.host.notify('The math has not been rendered yet.', 'info');
        void saveMathAs(p, el).catch((e) => this.host.notify(`Could not save the math: ${String(e)}`, 'error'));
      },
      saveVideoAs: this.host.saveVideoAs,
      tableAction: (a) => this.tableAction(a),
      editBlock: () => {
        const pv = t.block?.querySelector('.mb-preview');
        pv?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 0 }));
      },
      copyDiagramImage: () => {
        const s = svg();
        if (!s) return this.host.notify('The diagram has not been rendered yet.', 'info');
        void copySvgAsPng(s).then((ok) => ok || this.host.notify('Could not copy the diagram image.', 'error'));
      },
      saveDiagram: () => {
        const s = svg();
        if (!s) return this.host.notify('The diagram has not been rendered yet.', 'info');
        void (async () => {
          const out = await p.saveFileDialog({ defaultPath: 'diagram.svg', filters: [{ name: 'SVG', extensions: ['svg'] }] });
          if (out) await p.writeTextFile(out, svgSource(s));
        })().catch((e) => this.host.notify(`Could not save the diagram: ${String(e)}`, 'error'));
      },
    };
  }

  close(): void {
    closeContextMenu();
  }
}
