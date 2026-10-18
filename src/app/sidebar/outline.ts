import type { Heading } from '../../contracts';
import { h, icon, clearChildren } from '../util/dom';
import { showContextMenu, type MenuItem } from '../ui/contextmenu';

export interface OutlineOptions {
  /** "Collapsible Outline" (true) vs "Flat Outline" (false, default). */
  collapsible: boolean;
  onCollapsibleChange?(on: boolean): void;
}

/** Index of each heading's parent (nearest previous heading with a lower level), -1 for roots. */
export function headingParents(headings: Pick<Heading, 'level'>[]): number[] {
  const stack: number[] = [];
  return headings.map((hd, i) => {
    while (stack.length && headings[stack[stack.length - 1]].level >= hd.level) stack.pop();
    const p = stack.length ? stack[stack.length - 1] : -1;
    stack.push(i);
    return p;
  });
}

/** Rows kept by the Filter: case-insensitive substring of the label; ancestors are not kept. */
export function filterHeadings(headings: Pick<Heading, 'text'>[], query: string): Set<number> {
  const q = query.trim().toLowerCase();
  if (!q) return new Set(headings.map((_, i) => i));
  const keep = new Set<number>();
  headings.forEach((hd, i) => hd.text.toLowerCase().includes(q) && keep.add(i));
  return keep;
}

/**
 * Outline panel (#101, `typora.sidebar.outline-collapse`; fe-contextmenus-tools §2):
 * flat or collapsible tree, Expand All / Collapse All, Filter box, Highlight
 * Current Header, context menu in Typora's order.
 */
export class OutlineView {
  readonly el: HTMLElement;
  private list: HTMLElement;
  private filterBar: HTMLElement;
  readonly filterInput: HTMLInputElement;
  private items = new Map<string, HTMLElement>();
  private activeId: string | null = null;
  private shownActive: string | null = null;
  private lastKey = '';
  private headings: Heading[] = [];
  private parents: number[] = [];
  /** Expanded heading ids (collapsible mode); kept across edits by heading identity. */
  private expanded = new Set<string>();
  private filled = false;
  private collapsible: boolean;

  constructor(private onPick: (id: string) => void, private opts: OutlineOptions = { collapsible: false }) {
    this.collapsible = opts.collapsible;
    this.list = h('ol.outline-list', { role: 'tree', 'aria-label': 'Outline' });
    this.filterInput = h('input.outline-filter', { type: 'search', placeholder: 'Filter', 'aria-label': 'Filter', spellcheck: 'false' });
    this.filterInput.addEventListener('input', () => this.applyVisibility());
    this.filterInput.addEventListener('keydown', (e) => this.onFilterKey(e));
    const close = h('button.icon-btn.outline-filter-close', { type: 'button', title: 'Close', 'aria-label': 'Close Filter', onclick: () => this.closeFilter() }, icon('close'));
    this.filterBar = h('div.outline-header', { hidden: true }, icon('search', 'search-icon'), this.filterInput, close);
    this.el = h('div.outline', { 'data-collapsible': String(this.collapsible) }, this.filterBar, this.list);
    this.el.addEventListener('contextmenu', (e) => {
      if ((e.target as HTMLElement).closest('input')) return;
      e.preventDefault();
      this.showMenu(e.clientX, e.clientY);
    });
  }

  get isCollapsible(): boolean {
    return this.collapsible;
  }

  get filtering(): boolean {
    return !this.filterBar.hidden;
  }

  setCollapsible(on: boolean): void {
    if (on === this.collapsible) return;
    this.collapsible = on;
    this.el.dataset.collapsible = String(on);
    // Choosing collapsible expands every top-level item.
    if (on) this.headings.forEach((hd, i) => this.parents[i] === -1 && this.hasChildren(i) && this.expanded.add(hd.id));
    this.lastKey = '';
    this.update(this.headings);
    this.opts.onCollapsibleChange?.(on);
  }

  expandAll(): void {
    this.headings.forEach((hd, i) => this.hasChildren(i) && this.expanded.add(hd.id));
    this.applyVisibility();
  }

  collapseAll(): void {
    this.expanded.clear();
    this.applyVisibility();
  }

  openFilter(q = ''): void {
    this.filterBar.hidden = false;
    this.filterInput.value = q;
    this.filterInput.focus();
    this.applyVisibility();
  }

  closeFilter(): void {
    this.filterBar.hidden = true;
    this.filterInput.value = '';
    this.applyVisibility();
  }

  /** Expand the active heading's ancestors and blink its row for 2 s. */
  highlightCurrent(): void {
    const i = this.headings.findIndex((x) => x.id === this.activeId);
    if (i < 0) return;
    for (let p = this.parents[i]; p >= 0; p = this.parents[p]) this.expanded.add(this.headings[p].id);
    this.applyVisibility();
    const el = this.items.get(this.activeId!);
    el?.scrollIntoView({ block: 'nearest' });
    el?.classList.add('flash');
    setTimeout(() => el?.classList.remove('flash'), 2000);
  }

  private showMenu(x: number, y: number): void {
    const items: MenuItem[] = [{ label: 'Highlight Current Header', run: () => this.highlightCurrent(), disabled: !this.activeId }, { separator: true }];
    items.push({ label: 'Filter', checked: this.filtering, run: () => (this.filtering ? this.closeFilter() : this.openFilter()) });
    if (!this.filtering) {
      if (this.collapsible) items.push({ separator: true }, { label: 'Expand All', run: () => this.expandAll() }, { label: 'Collapse All', run: () => this.collapseAll() });
      items.push(
        { separator: true },
        { label: 'Collapsible Outline', checked: this.collapsible, run: () => this.setCollapsible(true) },
        { label: 'Flat Outline', checked: !this.collapsible, run: () => this.setCollapsible(false) },
      );
    }
    showContextMenu(x, y, items);
  }

  private hasChildren(i: number): boolean {
    return i + 1 < this.headings.length && this.parents[i + 1] === i;
  }

  update(headings: Heading[]): void {
    const key = headings.map((x) => `${x.id}|${x.level}|${x.text}`).join('\n');
    if (key === this.lastKey) return;
    this.lastKey = key;
    this.headings = headings;
    this.parents = headingParents(headings);
    clearChildren(this.list);
    this.items.clear();
    if (!headings.length) {
      this.list.appendChild(h('li.outline-empty', { text: 'Outline is Empty.' }));
      return;
    }
    const ids = new Set(headings.map((x) => x.id));
    for (const id of [...this.expanded]) if (!ids.has(id)) this.expanded.delete(id);
    if (!this.filled) {
      // First fill: a single top-level item starts expanded.
      this.filled = true;
      const tops = headings.filter((_, i) => this.parents[i] === -1);
      if (tops.length === 1) this.expanded.add(tops[0].id);
    }
    const min = Math.min(...headings.map((x) => x.level));
    headings.forEach((hd, i) => {
      const parent = this.collapsible && this.hasChildren(i);
      const toggle = parent
        ? h('span.outline-toggle', { 'aria-hidden': 'true' }, icon('chevron'))
        : this.collapsible
          ? h('span.outline-toggle-space')
          : null;
      const item = h(
        'li.outline-item',
        { role: 'treeitem', tabindex: '0', 'data-id': hd.id, 'data-level': hd.level, style: `--depth:${hd.level - min}`, title: hd.text },
        toggle,
        h('span.outline-text', { text: hd.text }),
      );
      if (parent) {
        item.setAttribute('aria-expanded', 'false');
        toggle!.addEventListener('click', (e) => {
          e.stopPropagation();
          this.toggle(hd.id);
        });
      }
      item.addEventListener('click', () => {
        if (parent) this.toggle(hd.id, true);
        this.onPick(hd.id);
      });
      item.addEventListener('keydown', (e) => this.onKey(e, hd.id, i));
      this.items.set(hd.id, item);
      this.list.appendChild(item);
    });
    const a = this.activeId;
    this.activeId = null;
    this.setActive(a);
    this.applyVisibility();
  }

  toggle(id: string, open?: boolean): void {
    const want = open ?? !this.expanded.has(id);
    if (want) this.expanded.add(id);
    else this.expanded.delete(id);
    this.applyVisibility();
  }

  private onKey(e: KeyboardEvent, id: string, i: number): void {
    if (e.key === 'Enter' || e.key === ' ') this.onPick(id);
    else if (this.collapsible && e.key === 'ArrowLeft' && this.hasChildren(i)) this.toggle(id, false);
    else if (this.collapsible && e.key === 'ArrowRight' && this.hasChildren(i)) this.toggle(id, true);
    else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') this.moveFocus(e.currentTarget as HTMLElement, e.key === 'ArrowDown' ? 1 : -1);
    else return;
    e.preventDefault();
  }

  private moveFocus(from: HTMLElement | null, dir: 1 | -1): void {
    const vis = [...this.list.querySelectorAll<HTMLElement>('.outline-item:not([hidden])')];
    const k = from ? vis.indexOf(from) : -1;
    vis[dir === 1 ? Math.min(vis.length - 1, k + 1) : Math.max(0, k - 1)]?.focus();
  }

  private onFilterKey(e: KeyboardEvent): void {
    if (e.key === 'Escape') this.closeFilter();
    else if (e.key === 'ArrowDown') this.moveFocus(null, 1);
    else if (e.key === 'Enter') this.list.querySelector<HTMLElement>('.outline-item:not([hidden])')?.click();
    else return;
    e.preventDefault();
    e.stopPropagation();
  }

  /** Hide filtered-out rows and descendants of collapsed ones; mark the first hit in each label. */
  private applyVisibility(): void {
    const q = this.filtering ? this.filterInput.value.trim() : '';
    const keep = filterHeadings(this.headings, q);
    this.headings.forEach((hd, i) => {
      const el = this.items.get(hd.id);
      if (!el) return;
      let hidden = !keep.has(i);
      if (!q && this.collapsible) {
        for (let p = this.parents[i]; p >= 0; p = this.parents[p]) if (!this.expanded.has(this.headings[p].id)) hidden = true;
      }
      el.hidden = hidden;
      if (el.hasAttribute('aria-expanded')) el.setAttribute('aria-expanded', String(this.expanded.has(hd.id)));
      const label = el.querySelector('.outline-text')!;
      const at = q ? hd.text.toLowerCase().indexOf(q.toLowerCase()) : -1;
      if (at >= 0) label.replaceChildren(hd.text.slice(0, at), h('mark', { text: hd.text.slice(at, at + q.length) }), hd.text.slice(at + q.length));
      else label.textContent = hd.text;
    });
    this.list.querySelector('.outline-nomatch')?.remove();
    if (q && this.headings.length && !keep.size) this.list.appendChild(h('li.outline-nomatch', { text: 'No Results' }));
    this.paintActive();
  }

  setActive(id: string | null): void {
    if (id === this.activeId) return;
    this.activeId = id;
    this.paintActive();
  }

  /** Highlight the active heading, or its nearest visible ancestor when collapsed away. */
  private paintActive(): void {
    let i = this.headings.findIndex((x) => x.id === this.activeId);
    while (i >= 0 && this.items.get(this.headings[i].id)?.hidden && this.parents[i] >= 0) i = this.parents[i];
    const id = i >= 0 ? this.headings[i].id : null;
    if (id === this.shownActive && (!id || this.items.get(id)?.classList.contains('active'))) return;
    if (this.shownActive) this.items.get(this.shownActive)?.classList.remove('active');
    this.shownActive = id;
    const el = id ? this.items.get(id) : null;
    if (el && !el.hidden) {
      el.classList.add('active');
      el.scrollIntoView({ block: 'nearest' });
    }
  }
}
