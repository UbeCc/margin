import { h } from '../util/dom';

/** Generic modal shell: backdrop + centered card. Escape / backdrop click → onDismiss. */
export function openModal(
  content: HTMLElement,
  opts: { className?: string; onDismiss?: () => void; label?: string; /** false: Escape / backdrop clicks do nothing. */ dismissable?: boolean } = {},
): { close(): void; root: HTMLElement } {
  const prevFocus = document.activeElement as HTMLElement | null;
  const card = h('div.modal-card', { role: 'dialog', 'aria-modal': 'true', 'aria-label': opts.label ?? null }, content);
  if (opts.className) card.classList.add(opts.className);
  const root = h('div.modal-backdrop', null, card);
  let closed = false;
  const close = (): void => {
    if (closed) return;
    closed = true;
    root.remove();
    document.removeEventListener('keydown', onKey, true);
    prevFocus?.focus?.();
  };
  const onKey = (e: KeyboardEvent): void => {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      if (opts.dismissable === false) return;
      close();
      opts.onDismiss?.();
    } else if (e.key === 'Tab') {
      // focus trap
      const f = [...card.querySelectorAll<HTMLElement>('button, input, select, textarea, [tabindex]:not([tabindex="-1"])')].filter(
        (x) => !x.hasAttribute('disabled') && x.offsetParent !== null,
      );
      if (!f.length) return;
      const i = f.indexOf(document.activeElement as HTMLElement);
      const next = e.shiftKey ? (i <= 0 ? f.length - 1 : i - 1) : i === f.length - 1 ? 0 : i + 1;
      e.preventDefault();
      f[next].focus();
    }
  };
  root.addEventListener('mousedown', (e) => {
    if (e.target === root && opts.dismissable !== false) {
      close();
      opts.onDismiss?.();
    }
  });
  document.addEventListener('keydown', onKey, true);
  document.body.appendChild(root);
  return { close, root };
}

export interface ConfirmButton<T extends string> {
  id: T;
  label: string;
  primary?: boolean;
  danger?: boolean;
}

/**
 * Message box with N buttons. Resolves the clicked button id (or `cancelId`
 * on Escape) plus the final state of the optional suppression checkbox —
 * Typora's `window.showDialog {message, buttons, checkbox}` shape.
 */
export function ask<T extends string>(opts: {
  title: string;
  message?: string;
  buttons: ConfirmButton<T>[];
  cancelId: T;
  /** Suppression checkbox under the message ("Do not ask again" pattern). */
  checkbox?: { label: string; checked?: boolean };
}): Promise<{ id: T; checked: boolean }> {
  return new Promise((resolve) => {
    let checked = opts.checkbox?.checked ?? false;
    let done = false;
    const finish = (id: T): void => {
      if (done) return;
      done = true;
      modal.close();
      resolve({ id, checked });
    };
    const btns = opts.buttons.map((b) =>
      h('button.btn', {
        type: 'button',
        class: [b.primary ? 'btn-primary' : '', b.danger ? 'btn-danger' : ''].filter(Boolean).join(' ') || null,
        'data-id': b.id,
        text: b.label,
        onclick: () => finish(b.id),
      }),
    );
    const box = opts.checkbox
      ? h('label.dialog-checkbox', null, h('input', { type: 'checkbox', checked: checked || null, onchange: (e: Event) => (checked = (e.target as HTMLInputElement).checked) }), h('span', { text: opts.checkbox.label }))
      : null;
    const body = h(
      'div.dialog',
      null,
      h('h2.dialog-title', { text: opts.title }),
      opts.message ? h('p.dialog-message', { text: opts.message }) : null,
      box,
      h('div.dialog-buttons', null, ...btns),
    );
    const modal = openModal(body, { className: 'dialog-card', onDismiss: () => finish(opts.cancelId), label: opts.title });
    (btns.find((_, i) => opts.buttons[i].primary) ?? btns[0])?.focus();
  });
}

export async function confirmDialog(title: string, message?: string, okLabel = 'OK', danger = false): Promise<boolean> {
  const r = await ask({
    title,
    message,
    buttons: [
      { id: 'cancel', label: 'Cancel' },
      { id: 'ok', label: okLabel, primary: !danger, danger },
    ],
    cancelId: 'cancel',
  });
  return r.id === 'ok';
}

/** Single-line text prompt. `selectStem` selects the name without extension (for renames). */
export function promptDialog(opts: {
  title: string;
  value?: string;
  placeholder?: string;
  okLabel?: string;
  selectStem?: boolean;
  validate?: (v: string) => string | null;
}): Promise<string | null> {
  return new Promise((resolve) => {
    let done = false;
    const input = h('input.text-input', { type: 'text', value: opts.value ?? '', placeholder: opts.placeholder ?? '', spellcheck: 'false' });
    const err = h('div.dialog-error');
    const finish = (v: string | null): void => {
      if (done) return;
      if (v !== null && opts.validate) {
        const e = opts.validate(v);
        if (e) {
          err.textContent = e;
          input.focus();
          return;
        }
      }
      done = true;
      modal.close();
      resolve(v);
    };
    const form = h(
      'form.dialog',
      null,
      h('h2.dialog-title', { text: opts.title }),
      input,
      err,
      h(
        'div.dialog-buttons',
        null,
        h('button.btn', { type: 'button', text: 'Cancel', onclick: () => finish(null) }),
        h('button.btn.btn-primary', { type: 'submit', text: opts.okLabel ?? 'OK' }),
      ),
    );
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      finish(input.value.trim());
    });
    const modal = openModal(form, { className: 'dialog-card', onDismiss: () => finish(null), label: opts.title });
    input.focus();
    const v = input.value;
    const dot = v.lastIndexOf('.');
    if (opts.selectStem && dot > 0) input.setSelectionRange(0, dot);
    else input.select();
  });
}
