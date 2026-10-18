/**
 * Export dialogs (#95): overwrite confirmation for "Export and Overwrite with
 * Previous", and File › Page Setup.
 */
import { DEFAULT_PAGE, migratePageSetup, PAPER_LABELS, paperSizeMm, type PageSetup, type PaperName } from './export-settings';
import { openModal } from './ui/modal';
import { h } from './util/dom';

export function confirmOverwriteDialog(path: string): Promise<{ choice: 'overwrite' | 'keep-both' | 'cancel'; dontAsk: boolean }> {
  return new Promise((resolve) => {
    let done = false;
    const dontAsk = h('input', { type: 'checkbox', 'data-id': 'dont-ask' });
    const finish = (choice: 'overwrite' | 'keep-both' | 'cancel'): void => {
      if (done) return;
      done = true;
      modal.close();
      resolve({ choice, dontAsk: choice !== 'cancel' && dontAsk.checked });
    };
    const btn = (id: 'overwrite' | 'keep-both' | 'cancel', label: string, cls = ''): HTMLButtonElement =>
      h('button.btn', { type: 'button', class: cls || null, 'data-id': id, text: label, onclick: () => finish(id) });
    const overwrite = btn('overwrite', 'Overwrite', 'btn-primary');
    const body = h(
      'div.dialog.export-overwrite',
      null,
      h('h2.dialog-title', { text: 'Overwrite the previous export?' }),
      h('p.dialog-message', { text: `"Export and Overwrite with Previous" will overwrite the file at ${path}. Do you want to continue?` }),
      h('label.dialog-check', null, dontAsk, h('span', { text: 'Do not ask again' })),
      h('div.dialog-buttons', null, btn('cancel', 'Cancel'), btn('keep-both', 'Keep Both'), overwrite),
    );
    const modal = openModal(body, { className: 'dialog-card', onDismiss: () => finish('cancel'), label: 'Overwrite' });
    overwrite.focus();
  });
}

const mmInput = (key: string, value: number, min = 0, max = 100): HTMLInputElement =>
  h('input.number', { type: 'number', min: String(min), max: String(max), step: '0.5', value: String(value), 'data-page': key });

/** Page geometry editor used by File › Page Setup and the PDF section of Preferences. */
export function pageSetupFields(initial: PageSetup, onChange: (p: PageSetup) => void): HTMLElement {
  let page = migratePageSetup(initial);
  const paper = h('select.select', { 'data-page': 'paper' }, ...PAPER_LABELS.map(([v, l]) => h('option', { value: v, text: l })));
  paper.value = page.paper;
  const cw = mmInput('customWidth', page.custom[0], 50, 2000);
  const ch = mmInput('customHeight', page.custom[1], 50, 2000);
  const custom = h('span.inline.page-custom', null, cw, h('span.unit', { text: '×' }), ch, h('span.unit', { text: 'mm' }));
  const orient = h('select.select', { 'data-page': 'orientation' }, h('option', { value: 'portrait', text: 'Portrait' }), h('option', { value: 'landscape', text: 'Landscape' }));
  orient.value = page.orientation;
  const m = page.margins;
  const mt = mmInput('marginTop', m.top);
  const mr = mmInput('marginRight', m.right);
  const mb = mmInput('marginBottom', m.bottom);
  const ml = mmInput('marginLeft', m.left);
  const size = h('span.pref-hint.page-size');
  const sync = (): void => {
    custom.hidden = page.paper !== 'custom';
    const [w, hh] = paperSizeMm(page);
    size.textContent = `${Math.round(w * 10) / 10} × ${Math.round(hh * 10) / 10} mm`;
  };
  const read = (): void => {
    page = migratePageSetup({
      paper: paper.value as PaperName,
      custom: [Number(cw.value), Number(ch.value)],
      orientation: orient.value,
      margins: { top: Number(mt.value), right: Number(mr.value), bottom: Number(mb.value), left: Number(ml.value) },
    });
    sync();
    onChange(page);
  };
  for (const el of [paper, cw, ch, orient, mt, mr, mb, ml]) el.addEventListener('change', read);
  sync();
  const row = (label: string, ...ctl: (HTMLElement | null)[]): HTMLElement =>
    h('label.pref-row', null, h('span.pref-label', { text: label }), h('span.pref-control', null, ...ctl));
  return h(
    'div.page-setup-fields',
    null,
    row('Paper Size', paper, custom, size),
    row('Orientation', orient),
    row('Margin Top', h('span.inline', null, mt, h('span.unit', { text: 'mm' }))),
    row('Margin Bottom', h('span.inline', null, mb, h('span.unit', { text: 'mm' }))),
    row('Margin Left', h('span.inline', null, ml, h('span.unit', { text: 'mm' }))),
    row('Margin Right', h('span.inline', null, mr, h('span.unit', { text: 'mm' }))),
  );
}

/** File › Page Setup: resolves the new setup, or null when cancelled. */
export function openPageSetup(current: PageSetup): Promise<PageSetup | null> {
  return new Promise((resolve) => {
    let page = current;
    let done = false;
    const finish = (v: PageSetup | null): void => {
      if (done) return;
      done = true;
      modal.close();
      resolve(v);
    };
    const fields = pageSetupFields(current, (p) => (page = p));
    const body = h(
      'div.dialog.page-setup',
      null,
      h('h2.dialog-title', { text: 'Page Setup' }),
      h('p.dialog-message', { text: 'Used when printing and exporting to PDF.' }),
      fields,
      h(
        'div.dialog-buttons',
        null,
        h('button.btn', { type: 'button', 'data-id': 'reset', text: 'Defaults', onclick: () => finish(migratePageSetup(DEFAULT_PAGE)) }),
        h('button.btn', { type: 'button', 'data-id': 'cancel', text: 'Cancel', onclick: () => finish(null) }),
        h('button.btn.btn-primary', { type: 'button', 'data-id': 'ok', text: 'OK', onclick: () => finish(page) }),
      ),
    );
    const modal = openModal(body, { className: 'dialog-card', onDismiss: () => finish(null), label: 'Page Setup' });
    (fields.querySelector('select') as HTMLSelectElement | null)?.focus();
  });
}
