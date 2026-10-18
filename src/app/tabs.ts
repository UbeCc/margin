import { h } from './util/dom';
import './tabs.css';

/** What the tab bar needs to know about one open document (#94, #23). */
export interface TabView {
  id: string;
  name: string;
  path: string | null;
  dirty: boolean;
  missing: boolean;
}

export interface TabBarHost {
  activate(id: string): void;
  close(id: string): void;
  newTab(): void;
  /** Drag-reorder: move tab `id` to index `to`. */
  move(id: string, to: number): void;
  /** Context menu on a tab (optional). */
  menu?(id: string, e: MouseEvent): void;
}

/**
 * Document tabs above the editor. Hidden while only one document is open (like
 * Typora's tab bar, which appears with the second tab); the shell sets
 * `.has-tabs` on the app root from {@link TabBar.render}.
 */
export class TabBar {
  readonly el: HTMLElement;
  private list: HTMLElement;
  private dragId: string | null = null;

  constructor(private host: TabBarHost) {
    this.list = h('div.tab-list', { role: 'tablist', 'aria-label': 'Open documents' });
    const add = h('button.tab-new', { type: 'button', title: 'New Tab', 'aria-label': 'New Tab', text: '+', onclick: () => host.newTab() });
    this.el = h('nav.tab-bar', null, this.list, add);
    this.list.addEventListener('dblclick', (e) => {
      if (e.target === this.list) host.newTab();
    });
  }

  render(tabs: TabView[], active: string): void {
    this.list.replaceChildren(...tabs.map((t, i) => this.tab(t, i, t.id === active)));
    this.el.hidden = tabs.length < 2;
    this.list.querySelector<HTMLElement>('.tab[aria-selected="true"]')?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
  }

  private tab(t: TabView, index: number, selected: boolean): HTMLElement {
    const close = h('button.tab-close', {
      type: 'button',
      tabindex: '-1',
      'aria-label': `Close ${t.name}`,
      title: 'Close Tab',
      text: '×',
      onclick: (e: Event) => {
        e.stopPropagation();
        this.host.close(t.id);
      },
    });
    const el = h(
      'div.tab',
      {
        role: 'tab',
        draggable: 'true',
        'data-tab-id': t.id,
        'data-tab-path': t.path ?? '',
        'aria-selected': String(selected),
        title: t.path ?? t.name,
        class: [t.dirty ? 'dirty' : '', t.missing ? 'missing' : ''].filter(Boolean).join(' ') || null,
      },
      h('span.tab-dirty', { 'aria-hidden': 'true' }),
      h('span.tab-label', { text: t.name }),
      close,
    );
    el.addEventListener('mousedown', (e) => {
      if (e.button === 1) {
        e.preventDefault();
        this.host.close(t.id);
      }
    });
    el.addEventListener('click', () => this.host.activate(t.id));
    el.addEventListener('contextmenu', (e) => {
      if (!this.host.menu) return;
      e.preventDefault();
      this.host.menu(t.id, e);
    });
    el.addEventListener('dragstart', (e) => {
      this.dragId = t.id;
      e.dataTransfer?.setData('application/x-margin-tab', t.id);
      if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move';
    });
    el.addEventListener('dragover', (e) => {
      if (!this.dragId) return;
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
    });
    el.addEventListener('drop', (e) => {
      if (!this.dragId) return;
      e.preventDefault();
      e.stopPropagation();
      const id = this.dragId;
      this.dragId = null;
      if (id !== t.id) this.host.move(id, index);
    });
    el.addEventListener('dragend', () => (this.dragId = null));
    return el;
  }
}
