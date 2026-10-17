import { h } from '../util/dom';

export type ToastKind = 'info' | 'success' | 'error' | 'warning';

export interface ToastOptions {
  kind?: ToastKind;
  /** ms; 0 = sticky. Default 3200 (errors 6000). */
  timeout?: number;
  action?: { label: string; run: () => void };
}

let host: HTMLElement | null = null;

function ensureHost(): HTMLElement {
  if (!host || !host.isConnected) {
    host = h('div.toasts', { role: 'status', 'aria-live': 'polite' });
    document.body.appendChild(host);
  }
  return host;
}

export function toast(message: string, opts: ToastOptions = {}): () => void {
  const kind = opts.kind ?? 'info';
  const el = h('div.toast', { 'data-kind': kind }, h('span.toast-msg', null, message));
  const dismiss = (): void => {
    if (!el.isConnected) return;
    el.classList.add('leaving');
    setTimeout(() => el.remove(), 180);
  };
  if (opts.action) {
    const { label, run } = opts.action;
    el.appendChild(
      h('button.toast-action', {
        type: 'button',
        text: label,
        onclick: () => {
          dismiss();
          run();
        },
      }),
    );
  }
  el.appendChild(h('button.toast-close', { type: 'button', 'aria-label': 'Dismiss', text: '×', onclick: dismiss }));
  const container = ensureHost();
  container.appendChild(el);
  while (container.children.length > 4) container.firstElementChild?.remove();
  const timeout = opts.timeout ?? (kind === 'error' ? 6000 : 3200);
  if (timeout > 0) setTimeout(dismiss, timeout);
  return dismiss;
}
