import { h } from '../util/dom';
import { openModal } from './modal';

/** Default size of Paragraph › Table › Insert Table… (rows include the header row). */
export const TABLE_DEFAULT = { cols: 3, rows: 3 };
const MAX = 200;

/** Insert Table dialog (#98): Columns × Rows. Resolves null on Cancel / Escape. */
export function insertTableDialog(init = TABLE_DEFAULT): Promise<{ rows: number; cols: number } | null> {
  return new Promise((resolve) => {
    let done = false;
    const num = (name: string, v: number) =>
      h('input.text-input.table-dim', { type: 'number', min: '1', max: String(MAX), value: String(v), name, 'aria-label': name }) as HTMLInputElement;
    const cols = num('Columns', init.cols);
    const rows = num('Rows', init.rows);
    const err = h('div.dialog-error');
    const finish = (ok: boolean): void => {
      if (done) return;
      const c = Math.floor(+cols.value);
      const r = Math.floor(+rows.value);
      if (ok && !(c >= 1 && c <= MAX && r >= 1 && r <= MAX)) {
        err.textContent = `Enter numbers between 1 and ${MAX}`;
        return;
      }
      done = true;
      modal.close();
      resolve(ok ? { rows: r, cols: c } : null);
    };
    const field = (label: string, input: HTMLInputElement) => h('label.dialog-field', null, h('span', { text: label }), input);
    const form = h(
      'form.dialog.table-dialog',
      null,
      h('h2.dialog-title', { text: 'Insert Table' }),
      field('Columns', cols),
      field('Rows', rows),
      err,
      h(
        'div.dialog-buttons',
        null,
        h('button.btn', { type: 'button', text: 'Cancel', onclick: () => finish(false) }),
        h('button.btn.btn-primary', { type: 'submit', text: 'OK' }),
      ),
    );
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      finish(true);
    });
    const modal = openModal(form, { className: 'dialog-card', onDismiss: () => finish(false), label: 'Insert Table' });
    cols.focus();
    cols.select();
  });
}
