/**
 * table widget (GFM pipe tables): a grid of contenteditable cells.
 *
 * Cells show rendered inline markdown when idle and their raw markdown while being
 * edited. Tab/Shift+Tab/Enter/arrows navigate; a toolbar (shown while the table
 * has focus) adds/removes rows & columns and sets column alignment. Unchanged
 * tables keep their original source; edits only rewrite touched rows (#6).
 */
import type { BlockWidget, EditorSettings, WidgetContext, WidgetInstance } from '../../contracts';
import {
  Align,
  cloneModel,
  deleteCol,
  deleteRow,
  insertCol,
  insertRow,
  locateCell,
  moveCol,
  moveRow,
  ParsedTable,
  parseClipboardGrid,
  pasteGrid,
  parseTable,
  serializeTable,
  setAlign,
  TableModel,
} from './table-model';
import { renderInlineMarkdown } from './inline-md';
import { inlineMathHTML } from './math';
import { h, isolateEvents, offsetAtPoint } from './util/dom';

interface Pos {
  r: number;
  c: number;
}

const MARKER_CHARS = new Set(['*', '_', '`', '~', '=', '\\', '$']);

/** Map an offset in rendered text to an offset in raw markdown (approximate). */
export function renderedToRawOffset(raw: string, off: number): number {
  let seen = 0;
  for (let i = 0; i < raw.length; i++) {
    if (seen >= off) return i;
    if (!MARKER_CHARS.has(raw[i])) seen++;
  }
  return raw.length;
}

/**
 * GFM: `\|` in a cell is a table-level escape, removed before inline parsing, so it
 * renders as `|` even inside code spans. Escaped backslashes (`\\`) stay as they are.
 */
export function unescapeCellPipes(text: string): string {
  return text.replace(/\\([\s\S])/g, (m, c: string) => (c === '|' ? '|' : m));
}

function cellHTML(text: string, settings: EditorSettings): string {
  return renderInlineMarkdown(unescapeCellPipes(text), { renderMath: inlineMathHTML, resolveAsset: (s) => settings.resolveAsset(s) });
}

function textOffset(el: HTMLElement): number | null {
  const sel = window.getSelection();
  if (!sel || !sel.rangeCount) return null;
  const r = sel.getRangeAt(0);
  if (!el.contains(r.startContainer)) return null;
  const pre = document.createRange();
  pre.selectNodeContents(el);
  pre.setEnd(r.startContainer, r.startOffset);
  return pre.toString().length;
}

function setCaret(el: HTMLElement, off: number) {
  const sel = window.getSelection();
  if (!sel) return;
  const range = document.createRange();
  let rest = off;
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  let n: Node | null;
  let placed = false;
  while ((n = walker.nextNode())) {
    const len = (n as Text).length;
    if (rest <= len) {
      range.setStart(n, rest);
      placed = true;
      break;
    }
    rest -= len;
  }
  if (!placed) {
    range.selectNodeContents(el);
    range.collapse(false);
  }
  range.collapse(true);
  sel.removeAllRanges();
  sel.addRange(range);
}

function selectRange(el: HTMLElement, from: number, to: number) {
  const sel = window.getSelection();
  if (!sel) return;
  const pos = (off: number): [Node, number] => {
    const w = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    let n: Node | null;
    let rest = off;
    while ((n = w.nextNode())) {
      if (rest <= (n as Text).length) return [n, rest];
      rest -= (n as Text).length;
    }
    return [el, el.childNodes.length];
  };
  const r = document.createRange();
  r.setStart(...pos(from));
  r.setEnd(...pos(to));
  sel.removeAllRanges();
  sel.addRange(r);
}

function cellText(el: HTMLElement): string {
  return (el.innerText ?? el.textContent ?? '').replace(/\u00a0/g, ' ').replace(/\r?\n/g, ' ');
}

const ALIGN_ICONS: [Align, string, string][] = [
  ['left', '⇤', 'Align left'],
  ['center', '↔', 'Align center'],
  ['right', '⇥', 'Align right'],
  [null, '∅', 'Default alignment'],
];

class TableInstance implements WidgetInstance {
  private raw: string;
  private orig: ParsedTable;
  private model: TableModel;
  private settings: EditorSettings;
  private root: HTMLElement;
  private tableEl: HTMLTableElement;
  private tools: HTMLElement;
  private cells: HTMLElement[][] = [];
  private active: Pos | null = null;
  private lastPos: Pos = { r: 0, c: 0 };

  constructor(
    host: HTMLElement,
    private ctx: WidgetContext,
  ) {
    this.raw = ctx.raw;
    this.orig = parseTable(ctx.raw);
    this.model = cloneModel(this.orig);
    this.settings = ctx.settings;
    this.tableEl = h('table', { class: 'mb-table-grid' });
    this.tools = this.buildTools();
    this.root = h(
      'div',
      { class: 'mb-block mb-table', contenteditable: 'false', 'data-type': 'table' },
      this.tools,
      h('div', { class: 'mb-table-scroll' }, this.tableEl),
    );
    this.root.dataset.scheme = this.settings.colorScheme;
    isolateEvents(this.root);
    host.append(this.root);
    this.root.addEventListener('focusin', () => this.root.classList.add('mb-active'));
    this.root.addEventListener('focusout', () =>
      setTimeout(() => {
        if (!this.root.contains(document.activeElement)) this.root.classList.remove('mb-active');
      }, 0),
    );
    this.buildGrid();
  }

  // ------------------------------------------------------------------ DOM

  private buildTools(): HTMLElement {
    const btn = (label: string, title: string, fn: () => void, cls = '') => {
      const b = h('button', { type: 'button', class: `mb-tbtn ${cls}`, title, 'aria-label': title }, label);
      b.addEventListener('mousedown', (e) => e.preventDefault()); // keep cell focus
      b.addEventListener('click', fn);
      return b;
    };
    const sep = () => h('span', { class: 'mb-tsep' });
    const aligns = ALIGN_ICONS.map(([a, icon, title]) => {
      const b = btn(icon, title, () => this.applyAlign(a), 'mb-align');
      b.dataset.align = a ?? 'none';
      return b;
    });
    return h(
      'div',
      { class: 'mb-table-tools', role: 'toolbar', 'aria-label': 'Table tools' },
      ...aligns,
      sep(),
      btn('+↑', 'Insert row above', () => this.structural((m, p) => [insertRow(m, Math.max(1, p.r)), { r: Math.max(1, p.r), c: p.c }]), 'mb-row-above'),
      btn('+↓', 'Insert row below (⌘↩)', () => this.structural((m, p) => [insertRow(m, p.r + 1), { r: p.r + 1, c: p.c }]), 'mb-row-below'),
      btn('−R', 'Delete row (⌘⇧⌫)', () => this.deleteRowAt(), 'mb-row-del'),
      sep(),
      btn('+←', 'Insert column left', () => this.structural((m, p) => [insertCol(m, p.c), { r: p.r, c: p.c }]), 'mb-col-left'),
      btn('+→', 'Insert column right', () => this.structural((m, p) => [insertCol(m, p.c + 1), { r: p.r, c: p.c + 1 }]), 'mb-col-right'),
      btn('−C', 'Delete column', () => this.structural((m, p) => [deleteCol(m, p.c), { r: p.r, c: Math.min(p.c, m.align.length - 2) }]), 'mb-col-del'),
      sep(),
      btn('🗑', 'Delete table', () => this.ctx.onRemove(), 'mb-table-del'),
    );
  }

  private buildGrid() {
    const { rows, align } = this.model;
    this.cells = [];
    const thead = h('thead');
    const tbody = h('tbody');
    rows.forEach((row, r) => {
      const tr = h('tr');
      const line: HTMLElement[] = [];
      row.forEach((text, c) => {
        const cell = h('div', { class: 'mb-cell', contenteditable: 'true', spellcheck: String(this.settings.spellcheck), role: 'textbox' });
        cell.dataset.r = String(r);
        cell.dataset.c = String(c);
        cell.innerHTML = cellHTML(text, this.settings);
        this.bindCell(cell);
        const td = h(r === 0 ? 'th' : 'td', null, cell);
        if (align[c]) td.style.textAlign = align[c]!;
        tr.append(td);
        line.push(cell);
      });
      this.cells.push(line);
      (r === 0 ? thead : tbody).append(tr);
    });
    this.tableEl.replaceChildren(thead, tbody);
    this.syncAlignButtons();
  }

  private bindCell(cell: HTMLElement) {
    const pos = (): Pos => ({ r: +cell.dataset.r!, c: +cell.dataset.c! });
    let clickOff: number | null = null;
    let keyed = false; // a key was pressed before the deferred caret mapping ran
    cell.addEventListener('mousedown', (e) => {
      if (cell.classList.contains('mb-editing')) return;
      // rendered → raw switch happens on focus; remember where the user clicked
      clickOff = offsetAtPoint(cell, e.clientX, e.clientY);
    });
    cell.addEventListener('focus', () => {
      if (cell.classList.contains('mb-editing')) return;
      const off = clickOff;
      clickOff = null;
      this.enterCell(cell, pos(), off ?? undefined);
      if (off !== null) {
        const raw = this.model.rows[pos().r][pos().c];
        keyed = false;
        setTimeout(() => !keyed && document.activeElement === cell && setCaret(cell, renderedToRawOffset(raw, off)), 0);
      }
    });
    cell.addEventListener('blur', () => this.leaveCell(cell, pos()));
    cell.addEventListener('input', () => {
      const p = pos();
      this.model.rows[p.r][p.c] = cellText(cell);
      this.emit();
    });
    cell.addEventListener('paste', (e) => {
      e.preventDefault();
      const text = e.clipboardData?.getData('text/plain') || '';
      const grid = parseClipboardGrid(text);
      if (grid) {
        const p = pos();
        const rows = grid.length;
        const cols = Math.max(...grid.map((g) => g.length));
        this.structural((m) => [pasteGrid(m, p.r, p.c, grid), { r: p.r + rows - 1, c: p.c + cols - 1 }], 'end');
        return;
      }
      document.execCommand('insertText', false, text.replace(/\r?\n/g, ' '));
    });
    cell.addEventListener('drop', (e) => e.preventDefault());
    // no native rich formatting (Cmd+U, context menu Bold…): cells hold plain markdown
    cell.addEventListener('beforeinput', (e) => {
      if (e.inputType.startsWith('format')) e.preventDefault();
    });
    cell.addEventListener('keydown', (e) => {
      keyed = true;
      this.onKey(e, cell, pos());
    });
  }

  private enterCell(cell: HTMLElement, p: Pos, renderedOff?: number) {
    this.active = p;
    this.lastPos = p;
    const raw = this.model.rows[p.r][p.c];
    cell.classList.add('mb-editing');
    if (cell.textContent !== raw || cell.childElementCount) cell.textContent = raw;
    if (renderedOff !== undefined) setCaret(cell, renderedToRawOffset(raw, renderedOff));
    this.syncAlignButtons();
  }

  private leaveCell(cell: HTMLElement, p: Pos) {
    cell.classList.remove('mb-editing');
    if (this.active && this.active.r === p.r && this.active.c === p.c) this.active = null;
    const text = this.model.rows[p.r]?.[p.c];
    if (text !== undefined) cell.innerHTML = cellHTML(text, this.settings);
  }

  private focusCell(p: Pos, at: 'start' | 'end' | number = 'end') {
    const r = Math.max(0, Math.min(p.r, this.cells.length - 1));
    const c = Math.max(0, Math.min(p.c, this.model.align.length - 1));
    const cell = this.cells[r]?.[c];
    if (!cell) return;
    cell.focus({ preventScroll: false });
    if (!cell.classList.contains('mb-editing')) this.enterCell(cell, { r, c });
    const len = (cell.textContent || '').length;
    setCaret(cell, at === 'start' ? 0 : at === 'end' ? len : Math.min(at, len));
  }

  private syncAlignButtons() {
    const c = (this.active ?? this.lastPos).c;
    const a = this.model.align[c] ?? null;
    this.tools.querySelectorAll<HTMLElement>('.mb-align').forEach((b) => b.classList.toggle('mb-on', b.dataset.align === (a ?? 'none')));
  }

  // ------------------------------------------------------------------ editing

  private emit() {
    const raw = serializeTable(this.orig, this.model);
    if (raw === this.raw) return;
    this.raw = raw;
    this.ctx.onChange(raw);
  }

  private structural(op: (m: TableModel, p: Pos) => [TableModel, Pos], at: 'start' | 'end' = 'start') {
    const p = this.active ?? this.lastPos;
    const [m, next] = op(this.model, p);
    this.model = m;
    this.active = null;
    this.buildGrid();
    this.emit();
    this.focusCell(next, at);
  }

  private deleteRowAt() {
    const p = this.active ?? this.lastPos;
    if (this.model.rows.length <= 1) {
      this.ctx.onRemove();
      return;
    }
    this.structural((m) => [deleteRow(m, p.r), { r: Math.min(p.r, m.rows.length - 2), c: p.c }]);
  }

  private applyAlign(a: Align) {
    const p = this.active ?? this.lastPos;
    this.model = setAlign(this.model, p.c, a);
    this.cells.forEach((row) => {
      const td = row[p.c]?.parentElement;
      if (td) td.style.textAlign = a ?? '';
    });
    this.emit();
    this.syncAlignButtons();
    this.focusCell(p, 'end');
  }

  private onKey(e: KeyboardEvent, cell: HTMLElement, p: Pos) {
    // IME composition (CJK input): Enter/arrows/Tab belong to the IME, not to the grid (#10).
    if (e.isComposing || e.keyCode === 229) return;
    const mod = e.metaKey || e.ctrlKey;
    const nrows = this.model.rows.length;
    const ncols = this.model.align.length;
    const len = (cell.textContent || '').length;
    const off = textOffset(cell) ?? 0;
    const sel = window.getSelection();
    const collapsed = !sel || sel.isCollapsed;
    const handled = () => {
      e.preventDefault();
      e.stopPropagation();
    };

    if (e.key === 'Tab') {
      handled();
      if (e.shiftKey) {
        if (p.c > 0) this.focusCell({ r: p.r, c: p.c - 1 }, 'end');
        else if (p.r > 0) this.focusCell({ r: p.r - 1, c: ncols - 1 }, 'end');
        else this.ctx.onExit('up');
      } else if (p.c < ncols - 1) this.focusCell({ r: p.r, c: p.c + 1 }, 'end');
      else if (p.r < nrows - 1) this.focusCell({ r: p.r + 1, c: 0 }, 'end');
      else this.structural((m) => [insertRow(m, nrows), { r: nrows, c: 0 }]);
      return;
    }
    if (e.key === 'Enter') {
      handled();
      if (e.shiftKey) {
        document.execCommand('insertText', false, '<br>');
        return;
      }
      if (mod) {
        this.structural((m) => [insertRow(m, p.r + 1), { r: p.r + 1, c: p.c }]);
        return;
      }
      if (p.r < nrows - 1) this.focusCell({ r: p.r + 1, c: p.c }, 'end');
      else this.structural((m) => [insertRow(m, nrows), { r: nrows, c: p.c }]);
      return;
    }
    if (mod && !e.shiftKey && !e.altKey && (e.key === 'a' || e.key === 'A')) {
      // Select the cell, not the whole document (the cell is a nested editing host).
      handled();
      const r = document.createRange();
      r.selectNodeContents(cell);
      const s = window.getSelection();
      s?.removeAllRanges();
      s?.addRange(r);
      return;
    }
    if (mod && !e.shiftKey && !e.altKey && (e.key === 'b' || e.key === 'i' || e.key === 'B' || e.key === 'I')) {
      // Markdown emphasis instead of the browser's <b>/<i> (which the model can't see).
      handled();
      this.wrapSelection(cell, e.key.toLowerCase() === 'b' ? '**' : '*');
      return;
    }
    if (mod && e.shiftKey && (e.key === 'Backspace' || e.key === 'Delete')) {
      handled();
      this.deleteRowAt();
      return;
    }
    if (e.altKey && mod && (e.key === 'ArrowUp' || e.key === 'ArrowDown') && p.r > 0) {
      handled();
      const to = p.r + (e.key === 'ArrowUp' ? -1 : 1);
      if (to >= 1 && to < nrows) this.structural((m) => [moveRow(m, p.r, to), { r: to, c: p.c }]);
      return;
    }
    if (e.altKey && mod && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {
      handled();
      const to = p.c + (e.key === 'ArrowLeft' ? -1 : 1);
      if (to >= 0 && to < ncols) this.structural((m) => [moveCol(m, p.c, to), { r: p.r, c: to }]);
      return;
    }
    if (e.shiftKey || mod || e.altKey) return;
    switch (e.key) {
      case 'ArrowUp':
        handled();
        if (p.r > 0) this.focusCell({ r: p.r - 1, c: p.c }, Math.min(off, len));
        else this.ctx.onExit('up');
        return;
      case 'ArrowDown':
        handled();
        if (p.r < nrows - 1) this.focusCell({ r: p.r + 1, c: p.c }, Math.min(off, len));
        else this.ctx.onExit('down');
        return;
      case 'ArrowLeft':
        if (!collapsed || off > 0) return;
        handled();
        if (p.c > 0) this.focusCell({ r: p.r, c: p.c - 1 }, 'end');
        else if (p.r > 0) this.focusCell({ r: p.r - 1, c: ncols - 1 }, 'end');
        else this.ctx.onExit('left');
        return;
      case 'ArrowRight':
        if (!collapsed || off < len) return;
        handled();
        if (p.c < ncols - 1) this.focusCell({ r: p.r, c: p.c + 1 }, 'start');
        else if (p.r < nrows - 1) this.focusCell({ r: p.r + 1, c: 0 }, 'start');
        else this.ctx.onExit('right');
        return;
      case 'Backspace':
        if (collapsed && off === 0 && this.model.rows.every((row) => row.every((x) => x === ''))) {
          handled();
          this.ctx.onRemove();
        } else if (collapsed && off === 0) handled(); // never merge cells
        return;
      case 'Escape':
        handled();
        this.ctx.onExit('down');
        return;
    }
  }

  /** Toggle `marker` around the selection (or insert an empty pair at the caret). */
  private wrapSelection(cell: HTMLElement, marker: string) {
    const sel = window.getSelection();
    if (!sel || !sel.rangeCount || !cell.contains(sel.anchorNode)) return;
    const text = cell.textContent || '';
    const start = textOffset(cell) ?? 0;
    const selected = sel.toString();
    const end = start + selected.length;
    const m = marker.length;
    const before = text.slice(Math.max(0, start - m), start);
    const after = text.slice(end, end + m);
    if (selected.length > 2 * m && selected.startsWith(marker) && selected.endsWith(marker)) {
      document.execCommand('insertText', false, selected.slice(m, -m));
    } else if (before === marker && after === marker && !(marker === '*' && (text[start - 2] === '*' || text[end + 1] === '*'))) {
      selectRange(cell, start - m, end + m);
      document.execCommand('insertText', false, selected);
    } else {
      document.execCommand('insertText', false, marker + selected + marker);
      if (!selected) setCaret(cell, start + m);
    }
  }

  // ------------------------------------------------------------------ WidgetInstance

  update(raw: string): void {
    if (raw === this.raw) return;
    const act = this.active;
    let off: number | null = null;
    if (act) off = textOffset(this.cells[act.r][act.c]);
    this.raw = raw;
    this.orig = parseTable(raw);
    this.model = cloneModel(this.orig);
    this.active = null;
    this.buildGrid();
    if (act) this.focusCell(act, off ?? 'end');
  }

  focus(at: 'start' | 'end'): void {
    if (at === 'start') this.focusCell({ r: 0, c: 0 }, 'start');
    else this.focusCell({ r: this.model.rows.length - 1, c: this.model.align.length - 1 }, 'end');
  }

  /** Find (#35): select text inside one cell; ranges over pipes/several cells → false. */
  select(from: number, to: number): boolean {
    const t = parseTable(this.raw);
    const hit = locateCell(t, from, to);
    if (!hit || this.model.rows[hit.r]?.[hit.c] !== t.rows[hit.r]?.[hit.c]) return false;
    const cell = this.cells[hit.r]?.[hit.c];
    if (!cell) return false;
    this.focusCell({ r: hit.r, c: hit.c }, hit.from);
    selectRange(cell, hit.from, hit.to);
    cell.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    return true;
  }

  renderHTML(): string {
    const { rows, align } = this.model;
    const st = (c: number) => (align[c] ? ` style="text-align:${align[c]}"` : '');
    const head = rows[0].map((t, c) => `<th${st(c)}>${cellHTML(t, this.settings)}</th>`).join('');
    const body = rows
      .slice(1)
      .map((r) => `<tr>${r.map((t, c) => `<td${st(c)}>${cellHTML(t, this.settings)}</td>`).join('')}</tr>`)
      .join('');
    return `<figure class="md-table-fig"><table><thead><tr>${head}</tr></thead>${body ? `<tbody>${body}</tbody>` : ''}</table></figure>`;
  }

  updateSettings(s: EditorSettings): void {
    this.settings = s;
    this.root.dataset.scheme = s.colorScheme;
  }

  destroy(): void {
    this.root.remove();
  }
}

export function createTableWidget(): BlockWidget {
  return { type: 'table', mount: (host, ctx) => new TableInstance(host, ctx) };
}

