import type { Heading } from '../../contracts';
import { h, clearChildren } from '../util/dom';

/** Outline panel: headings indented relative to the shallowest level present. */
export class OutlineView {
  readonly el: HTMLElement;
  private list: HTMLElement;
  private items = new Map<string, HTMLElement>();
  private activeId: string | null = null;
  private lastKey = '';

  constructor(private onPick: (id: string) => void) {
    this.list = h('ol.outline-list', { role: 'tree', 'aria-label': 'Outline' });
    this.el = h('div.outline', null, this.list);
  }

  update(headings: Heading[]): void {
    const key = headings.map((x) => `${x.id}|${x.level}|${x.text}`).join('\n');
    if (key === this.lastKey) return;
    this.lastKey = key;
    clearChildren(this.list);
    this.items.clear();
    if (!headings.length) {
      this.list.appendChild(h('li.outline-empty', { text: 'Headings you add will appear here.' }));
      return;
    }
    const min = Math.min(...headings.map((x) => x.level));
    for (const hd of headings) {
      const item = h(
        'li.outline-item',
        { role: 'treeitem', tabindex: '0', 'data-id': hd.id, 'data-level': hd.level, style: `--depth:${hd.level - min}`, title: hd.text },
        h('span.outline-text', { text: hd.text || '(untitled)' }),
      );
      item.addEventListener('click', () => this.onPick(hd.id));
      item.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          this.onPick(hd.id);
        }
      });
      this.items.set(hd.id, item);
      this.list.appendChild(item);
    }
    const a = this.activeId;
    this.activeId = null;
    this.setActive(a);
  }

  setActive(id: string | null): void {
    if (id === this.activeId) return;
    if (this.activeId) this.items.get(this.activeId)?.classList.remove('active');
    this.activeId = id;
    const el = id ? this.items.get(id) : null;
    if (el) {
      el.classList.add('active');
      el.scrollIntoView({ block: 'nearest' });
    }
  }
}
