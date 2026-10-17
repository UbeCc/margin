import { h, clearChildren } from '../util/dom';
import { renderHighlighted } from '../util/fuzzy';

export interface PaletteItem {
  id: string;
  label: string;
  /** Matched character indices in `label`. */
  labelHits?: number[];
  detail?: string;
  detailHits?: number[];
  /** Right-aligned hint, e.g. a shortcut. */
  hint?: string;
  kind?: string;
}

export interface PaletteOptions {
  placeholder: string;
  className?: string;
  initialQuery?: string;
  emptyText?: string;
  provide(query: string): PaletteItem[] | Promise<PaletteItem[]>;
  pick(item: PaletteItem, opts: { alt: boolean }): void;
  onClose?(): void;
}

let open: { close(): void; kind: string } | null = null;

export function isPaletteOpen(): boolean {
  return !!open;
}

export function closePalette(): void {
  open?.close();
}

/** Floating command/quick-open palette near the top of the window. */
export function openPalette(opts: PaletteOptions): void {
  const kind = opts.className ?? 'palette';
  if (open) {
    const sameKind = open.kind === kind;
    open.close();
    if (sameKind) return; // pressing the shortcut again toggles it off
  }
  const prevFocus = document.activeElement as HTMLElement | null;
  const input = h('input.palette-input', {
    type: 'text',
    placeholder: opts.placeholder,
    spellcheck: 'false',
    autocomplete: 'off',
    'aria-label': opts.placeholder,
    role: 'combobox',
    'aria-expanded': 'true',
  });
  const list = h('ul.palette-list', { role: 'listbox' });
  const root = h('div.palette', { class: opts.className ?? null }, h('div.palette-field', null, input), list);
  const backdrop = h('div.palette-backdrop', null, root);

  let items: PaletteItem[] = [];
  let selected = 0;
  let token = 0;

  const render = (): void => {
    clearChildren(list);
    if (!items.length) {
      list.appendChild(h('li.palette-empty', { text: opts.emptyText ?? 'No matches' }));
      return;
    }
    items.forEach((it, i) => {
      const label = h('span.palette-label');
      renderHighlighted(label, it.label, it.labelHits ?? []);
      let detail: HTMLElement | null = null;
      if (it.detail) {
        detail = h('span.palette-detail');
        renderHighlighted(detail, it.detail, it.detailHits ?? []);
      }
      const li = h(
        'li.palette-item',
        { role: 'option', 'aria-selected': String(i === selected), 'data-id': it.id, 'data-kind': it.kind ?? null },
        h('span.palette-text', null, label, detail),
        it.hint ? h('kbd.palette-hint', { text: it.hint }) : null,
      );
      if (i === selected) li.classList.add('selected');
      li.addEventListener('mousemove', () => {
        if (selected !== i) {
          selected = i;
          updateSelection();
        }
      });
      li.addEventListener('mousedown', (e) => e.preventDefault());
      li.addEventListener('click', (e) => choose(i, e.altKey));
      list.appendChild(li);
    });
  };
  const updateSelection = (): void => {
    [...list.children].forEach((li, i) => {
      li.classList.toggle('selected', i === selected);
      li.setAttribute('aria-selected', String(i === selected));
    });
    (list.children[selected] as HTMLElement | undefined)?.scrollIntoView({ block: 'nearest' });
  };
  const refresh = async (): Promise<void> => {
    const my = ++token;
    const res = await opts.provide(input.value);
    if (my !== token || !backdrop.isConnected) return;
    items = res;
    selected = 0;
    render();
  };
  const close = (): void => {
    if (!backdrop.isConnected) return;
    backdrop.remove();
    if (open?.close === close) open = null;
    opts.onClose?.();
  };
  const choose = (i: number, alt: boolean): void => {
    const it = items[i];
    if (!it) return;
    close();
    prevFocus?.focus?.();
    opts.pick(it, { alt });
  };

  input.addEventListener('input', () => void refresh());
  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown' || (e.ctrlKey && e.key === 'n')) {
      selected = Math.min(items.length - 1, selected + 1);
      updateSelection();
    } else if (e.key === 'ArrowUp' || (e.ctrlKey && e.key === 'p')) {
      selected = Math.max(0, selected - 1);
      updateSelection();
    } else if (e.key === 'Enter') {
      choose(selected, e.altKey);
    } else if (e.key === 'Escape') {
      close();
      prevFocus?.focus?.();
    } else return;
    e.preventDefault();
    e.stopPropagation();
  });
  backdrop.addEventListener('mousedown', (e) => {
    if (e.target === backdrop) {
      close();
      prevFocus?.focus?.();
    }
  });
  input.addEventListener('blur', () => setTimeout(() => {
    if (backdrop.isConnected && !backdrop.contains(document.activeElement)) close();
  }, 120));

  document.body.appendChild(backdrop);
  open = { close, kind };
  input.value = opts.initialQuery ?? '';
  input.focus();
  input.select();
  void refresh();
}
