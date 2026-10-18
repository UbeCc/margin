import { h } from '../util/dom';

/**
 * In-app context menu (#97). Items are actions, separators or submenus; an
 * action may carry a check mark (`checked`) and a shortcut / note (`hint`).
 * `id` is a stable key (Typora's context-menu key) used by tests and the
 * parity ledger; it is rendered as `data-key`.
 */
export type MenuItem =
  | { label: string; run: () => void; disabled?: boolean; danger?: boolean; hint?: string; checked?: boolean; id?: string }
  | { label: string; submenu: MenuItem[]; disabled?: boolean; id?: string }
  | { separator: true };

let current: { close(): void } | null = null;

export function closeContextMenu(): void {
  current?.close();
}

export function isContextMenuOpen(): boolean {
  return !!current;
}

/** Drop leading/trailing/double separators (lists are assembled from optional groups). */
export function tidy(items: MenuItem[]): MenuItem[] {
  const out: MenuItem[] = [];
  for (const it of items) {
    if ('separator' in it && (!out.length || 'separator' in out[out.length - 1])) continue;
    out.push(it);
  }
  while (out.length && 'separator' in out[out.length - 1]) out.pop();
  return out;
}

interface Level {
  el: HTMLElement;
  buttons: HTMLButtonElement[];
  parentBtn: HTMLButtonElement | null;
}

/** Show a small in-app context menu at (x, y). Keyboard: ↑/↓/←/→/Enter/Escape. */
export function showContextMenu(x: number, y: number, items: MenuItem[]): void {
  closeContextMenu();
  const levels: Level[] = [];

  const closeFrom = (depth: number): void => {
    while (levels.length > depth) {
      const l = levels.pop()!;
      l.el.remove();
      l.parentBtn?.setAttribute('aria-expanded', 'false');
    }
  };

  const place = (menu: HTMLElement, px: number, py: number, anchor?: DOMRect): void => {
    const r = menu.getBoundingClientRect();
    let left = px;
    if (anchor && left + r.width > window.innerWidth - 4) left = anchor.left - r.width + 2;
    menu.style.left = Math.max(4, Math.min(left, window.innerWidth - r.width - 4)) + 'px';
    menu.style.top = Math.max(4, Math.min(py, window.innerHeight - r.height - 4)) + 'px';
  };

  const openSub = (depth: number, btn: HTMLButtonElement, sub: MenuItem[], focusFirst: boolean): void => {
    const open = levels[depth + 1];
    if (open?.parentBtn === btn) {
      if (focusFirst) open.buttons.find((b) => !b.disabled)?.focus();
      return;
    }
    closeFrom(depth + 1);
    const r = btn.getBoundingClientRect();
    const lvl = build(sub, depth + 1, btn);
    place(lvl.el, r.right - 2, r.top - 5, r);
    btn.setAttribute('aria-expanded', 'true');
    if (focusFirst) lvl.buttons.find((b) => !b.disabled)?.focus();
  };

  function build(list: MenuItem[], depth: number, parentBtn: HTMLButtonElement | null): Level {
    const menu = h('div.context-menu', { role: 'menu', tabindex: '-1' });
    if (depth) menu.classList.add('context-submenu');
    const lvl: Level = { el: menu, buttons: [], parentBtn };
    for (const it of tidy(list)) {
      if ('separator' in it) {
        menu.appendChild(h('div.context-sep', { role: 'separator' }));
        continue;
      }
      const sub = 'submenu' in it ? it.submenu : null;
      const act = 'run' in it ? it : null;
      const b: HTMLButtonElement = h(
        'button.context-item',
        {
          type: 'button',
          role: act?.checked !== undefined ? 'menuitemcheckbox' : 'menuitem',
          disabled: !!it.disabled,
          class: act?.danger ? 'danger' : null,
          'data-key': it.id ?? null,
          'aria-haspopup': sub ? 'menu' : null,
          'aria-checked': act?.checked !== undefined ? String(!!act.checked) : null,
          onclick: () => {
            if (sub) return openSub(depth, b, sub, true);
            close();
            act!.run();
          },
          onmouseenter: () => {
            if (b.disabled) return;
            if (sub) openSub(depth, b, sub, false);
            else closeFrom(depth + 1);
          },
        },
        h('span.context-check', { text: act?.checked ? '✓' : '' }),
        h('span.context-label', { text: it.label }),
        sub ? h('span.context-hint', { text: '▸' }) : act?.hint ? h('span.context-hint', { text: act.hint }) : null,
      ) as HTMLButtonElement;
      lvl.buttons.push(b);
      menu.appendChild(b);
    }
    document.body.appendChild(menu);
    levels.push(lvl);
    return lvl;
  }

  const root = build(items, 0, null);
  place(root.el, x, y);

  const back = (depth: number): void => {
    const btn = levels[depth].parentBtn;
    closeFrom(depth);
    btn?.focus();
  };
  const onKey = (e: KeyboardEvent): void => {
    const depth = Math.max(0, levels.findIndex((l) => l.el.contains(document.activeElement)));
    const list = levels[depth].buttons.filter((b) => !b.disabled);
    const i = list.indexOf(document.activeElement as HTMLButtonElement);
    if (e.key === 'Escape') {
      if (depth > 0) back(depth);
      else close();
    } else if (e.key === 'ArrowDown') list[(i + 1) % list.length]?.focus();
    else if (e.key === 'ArrowUp') list[(i - 1 + list.length + (i < 0 ? 1 : 0)) % list.length]?.focus();
    else if (e.key === 'ArrowRight' && i >= 0 && list[i].getAttribute('aria-haspopup')) list[i].click();
    else if (e.key === 'ArrowLeft' && depth > 0) back(depth);
    else return;
    e.preventDefault();
    e.stopPropagation();
  };
  const onDown = (e: MouseEvent): void => {
    if (!levels.some((l) => l.el.contains(e.target as Node))) close();
  };
  function close(): void {
    closeFrom(0);
    document.removeEventListener('keydown', onKey, true);
    document.removeEventListener('mousedown', onDown, true);
    window.removeEventListener('blur', close);
    if (current === handle) current = null;
  }
  const handle = { close };
  current = handle;
  document.addEventListener('keydown', onKey, true);
  document.addEventListener('mousedown', onDown, true);
  window.addEventListener('blur', close);
  root.el.focus({ preventScroll: true });
}
