import { h } from '../util/dom';

export type MenuItem =
  | { label: string; run: () => void; disabled?: boolean; danger?: boolean; hint?: string }
  | { separator: true };

let current: { close(): void } | null = null;

export function closeContextMenu(): void {
  current?.close();
}

/** Show a small in-app context menu at (x, y). Keyboard: ↑/↓/Enter/Escape. */
export function showContextMenu(x: number, y: number, items: MenuItem[]): void {
  closeContextMenu();
  const buttons: HTMLButtonElement[] = [];
  const menu = h('div.context-menu', { role: 'menu', tabindex: '-1' });
  for (const it of items) {
    if ('separator' in it) {
      menu.appendChild(h('div.context-sep', { role: 'separator' }));
      continue;
    }
    const b = h(
      'button.context-item',
      {
        type: 'button',
        role: 'menuitem',
        disabled: !!it.disabled,
        class: it.danger ? 'danger' : null,
        onclick: () => {
          close();
          it.run();
        },
      },
      h('span', { text: it.label }),
      it.hint ? h('span.context-hint', { text: it.hint }) : null,
    );
    buttons.push(b);
    menu.appendChild(b);
  }
  document.body.appendChild(menu);
  const r = menu.getBoundingClientRect();
  menu.style.left = Math.max(4, Math.min(x, window.innerWidth - r.width - 4)) + 'px';
  menu.style.top = Math.max(4, Math.min(y, window.innerHeight - r.height - 4)) + 'px';

  const enabled = (): HTMLButtonElement[] => buttons.filter((b) => !b.disabled);
  const onKey = (e: KeyboardEvent): void => {
    const list = enabled();
    const i = list.indexOf(document.activeElement as HTMLButtonElement);
    if (e.key === 'Escape') close();
    else if (e.key === 'ArrowDown') list[(i + 1) % list.length]?.focus();
    else if (e.key === 'ArrowUp') list[(i - 1 + list.length + (i < 0 ? 1 : 0)) % list.length]?.focus();
    else return;
    e.preventDefault();
    e.stopPropagation();
  };
  const onDown = (e: MouseEvent): void => {
    if (!menu.contains(e.target as Node)) close();
  };
  function close(): void {
    menu.remove();
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
  menu.focus({ preventScroll: true });
}
