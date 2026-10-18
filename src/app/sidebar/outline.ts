import type { Heading } from '../../contracts';
import { h, icon, clearChildren } from '../util/dom';
import { showContextMenu } from '../ui/contextmenu';

export interface OutlineOptions {
  /** "Collapsible Outline" (true) vs "Flat Outline" (false). */
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

/** Headings kept by a filter: text matches (case-insensitive) plus their ancestors. */
export function filterHeadings(headings: Pick<Heading, 'level' | 'text'>[], query: string): Set<number> {
  const q = query.trim().toLowerCase();
  const keep = new Set<number>();
  if (!q) return new Set(headings.map((_, i) => i));
  const parents = headingParents(headings);
  headings.forEach((hd, i) => {
    if (!hd.text.toLowerCase().includes(q)) return;
    for (let j = i; j >= 0 && !keep.has(j); j = parents[j]) keep.add(j);
  });
  return keep;
}

/**
 * Outline panel (#101, `typora.sidebar.outline-collapse`): headings indented
 * relative to the shallowest level; optional collapsible tree with Expand All /
 * Collapse All, and a Filter box that keeps matching headings and their ancestors.
 */
export class OutlineView {
  readonly el: HTMLElement;
  private list: HTMLElement;
  readonly filterInput: HTMLInputElement;
  private items = new Map<string, HTMLElement>();
  private activeId: string | null = null;
  private lastKey = '';
  private headings: Heading[] = [];
  private parents: number[] = [];
  /** Collapsed heading ids (survive edits while the block id is stable). */
  private collapsed = new Set<string>();
  private collapsible: boolean;

  constructor(private onPick: (id: string) => void, private opts: OutlineOptions = { collapsible: false }) {
    this.collapsible = opts.collapsible;
    this.list = h('ol.outline-list', { role: 'tree', 'aria-label': 'Outline' });
    this.filterInput = h('input.outline-filter', { type: 'search', placeholder: 'Filter', 'aria-label': 'Filter', spellcheck: 'false' });
    this.filterInput.addEventListener('input', () => this.applyVisibility());
    this.filterInput.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && this.filterInput.value) {
        e.preventDefault();
        e.stopPropagation();
        this.filterInput.value = '';
        this.applyVisibility();
      }
    });
    const more = h('button.icon-btn.outline-more', { type: 'button', title: 'Outline Options', 'aria-label': 'Outline Options' }, icon('list'));
    more.addEventListener('click', () => {
      const r = more.getBoundingClientRect();
      this.showMenu(r.left, r.bottom + 2);
    });
    this.el = h('div.outline', { 'data-collapsible': String(this.collapsible) }, h('div.outline-header', null, this.filterInput, more), this.list);
    this.el.addEventListener('contextmenu', (e) => {
      if ((e.target as HTMLElement).closest('input')) return;
      e.preventDefault();
      this.showMenu(e.clientX, e.clientY);
    });
  }

  get isCollapsible(): boolean {
    return this.collapsible;
  }

  setCollapsible(on: boolean): void {
    if (on === this.collapsible) return;
    this.collapsible = on;
    this.el.dataset.collapsible = String(on);
    this.lastKey = '';
    this.update(this.headings);
    this.opts.onCollapsibleChange?.(on);
  }

  expandAll(): void {
    this.collapsed.clear();
    this.applyVisibility();
  }

  collapseAll(): void {
    this.headings.forEach((hd, i) => {
      if (this.hasChildren(i)) this.collapsed.add(hd.id);
    });
    this.applyVisibility();
  }

  setFilter(q: string): void {
    this.filterInput.value = q;
    this.applyVisibility();
  }

  private showMenu(x: number, y: number): void {
    showContextMenu(x, y, [
      { label: 'Collapsible Outline', checked: this.collapsible, run: () => this.setCollapsible(true) },
      { label: 'Flat Outline', checked: !this.collapsible, run: () => this.setCollapsible(false) },
      { separator: true },
      { label: 'Expand All', run: () => this.expandAll(), disabled: !this.collapsible },
      { label: 'Collapse All', run: () => this.collapseAll(), disabled: !this.collapsible },
      { separator: true },
      { label: 'Filter', run: () => this.filterInput.focus() },
    ]);
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
    for (const id of [...this.collapsed]) if (!ids.has(id)) this.collapsed.delete(id);
    const min = Math.min(...headings.map((x) => x.level));
    headings.forEach((hd, i) => {
      const parent = this.hasChildren(i) && this.collapsible;
      const toggle = parent
        ? h('span.outline-toggle', { 'aria-hidden': 'true' }, icon('chevron'))
        : this.collapsible
          ? h('span.outline-toggle-space')
          : null;
      const item = h(
        'li.outline-item',
        { role: 'treeitem', tabindex: '0', 'data-id': hd.id, 'data-level': hd.level, style: `--depth:${hd.level - min}`, title: hd.text },
        toggle,
        h('span.outline-text', { text: hd.text || '(untitled)' }),
      );
      if (parent) item.setAttribute('aria-expanded', 'true');
      toggle?.addEventListener('click', (e) => {
        if (!parent) return;
        e.stopPropagation();
        this.toggle(hd.id);
      });
      item.addEventListener('click', () => this.onPick(hd.id));
      item.addEventListener('keydown', (e) => this.onKey(e, hd.id, i));
      this.items.set(hd.id, item);
      this.list.appendChild(item);
    });
    this.applyVisibility();
    const a = this.activeId;
    this.activeId = null;
    this.setActive(a);
  }

  toggle(id: string, open?: boolean): void {
    const want = open ?? this.collapsed.has(id);
    if (want) this.collapsed.delete(id);
    else this.collapsed.add(id);
    this.applyVisibility();
  }

  private onKey(e: KeyboardEvent, id: string, i: number): void {
    if (e.key === 'Enter' || e.key === ' ') this.onPick(id);
    else if (this.collapsible && e.key === 'ArrowLeft' && this.hasChildren(i)) this.toggle(id, false);
    else if (this.collapsible && e.key === 'ArrowRight' && this.hasChildren(i)) this.toggle(id, true);
    else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      const vis = [...this.list.querySelectorAll<HTMLElement>('.outline-item:not([hidden])')];
      const k = vis.indexOf(e.currentTarget as HTMLElement);
      vis[e.key === 'ArrowDown' ? Math.min(vis.length - 1, k + 1) : Math.max(0, k - 1)]?.focus();
    } else return;
    e.preventDefault();
  }

  /** Hide filtered-out headings and descendants of collapsed ones. */
  private applyVisibility(): void {
    const keep = filterHeadings(this.headings, this.filterInput.value);
    const filtering = !!this.filterInput.value.trim();
    this.headings.forEach((hd, i) => {
      const el = this.items.get(hd.id);
      if (!el) return;
      let hidden = !keep.has(i);
      // While filtering, show matches even inside collapsed sections.
      if (!hidden && this.collapsible && !filtering) {
        for (let p = this.parents[i]; p >= 0; p = this.parents[p]) if (this.collapsed.has(this.headings[p].id)) hidden = true;
      }
      el.hidden = hidden;
      if (el.hasAttribute('aria-expanded')) el.setAttribute('aria-expanded', String(!this.collapsed.has(hd.id)));
    });
    this.list.querySelector('.outline-nomatch')?.remove();
    if (filtering && this.headings.length && !keep.size) this.list.appendChild(h('li.outline-nomatch', { text: 'No Results' }));
  }

  setActive(id: string | null): void {
    if (id === this.activeId) return;
    if (this.activeId) this.items.get(this.activeId)?.classList.remove('active');
    this.activeId = id;
    const el = id ? this.items.get(id) : null;
    if (el) {
      el.classList.add('active');
      if (!el.hidden) el.scrollIntoView({ block: 'nearest' });
    }
  }
}
