import { h } from '../util/dom';
import { openModal } from './modal';

/** Initial size of Paragraph › Table › Insert Table… (rows include the header row); later opens reuse the last size. */
export const TABLE_DEFAULT = { cols: 3, rows: 4 };
export const TABLE_MAX = { cols: 40, rows: 99 };
let last = { ...TABLE_DEFAULT };

/** Insert Table dialog (#98): Columns × Rows. Resolves null on Cancel / Escape. */
export function insertTableDialog(init = last): Promise<{ rows: number; cols: number } | null> {
  return new Promise((resolve) => {
    let done = false;
    const num = (name: string, v: number, max: number) =>
      h('input.text-input.table-dim', { type: 'number', min: '1', max: String(max), value: String(v), name, 'aria-label': name }) as HTMLInputElement;
    const cols = num('Columns', init.cols, TABLE_MAX.cols);
    const rows = num('Rows', init.rows, TABLE_MAX.rows);
    const err = h('div.dialog-error');
    const finish = (ok: boolean): void => {
      if (done) return;
      const c = Math.floor(+cols.value);
      const r = Math.floor(+rows.value);
      if (ok && !(c >= 1 && c <= TABLE_MAX.cols && r >= 1 && r <= TABLE_MAX.rows)) {
        err.textContent = `Columns must be between 1 and ${TABLE_MAX.cols}, rows between 1 and ${TABLE_MAX.rows}`;
        return;
      }
      if (ok) last = { rows: r, cols: c };
      done = true;
      modal.close();
      resolve(ok ? { rows: r, cols: c } : null);
    };
    const field = (label: string, input: HTMLInputElement) => h('label.dialog-field', null, h('span', { text: label }), input);
    const form = h(
      'form.dialog.table-dialog',
      { novalidate: true },
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
