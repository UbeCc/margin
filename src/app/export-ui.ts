/**
 * Export dialogs (#95): overwrite confirmation for "Export and Overwrite with
 * Previous", and File › Page Setup.
 */
import { DEFAULT_PRINT_SETUP, migratePageSetup, migratePrintSetup, PAPER_LABELS, paperSizeMm, type PageSetup, type PaperName, type PrintSetup } from './export-settings';
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
  h('input.number', { type: 'number', min: String(min), max: String(max), step: '0.5', value: String(Math.round(value * 100) / 100), 'data-page': key });

const row = (label: string, ...ctl: (HTMLElement | null)[]): HTMLElement =>
  h('label.pref-row', null, h('span.pref-label', { text: label }), h('span.pref-control', null, ...ctl));

/**
 * Preferences › Export › PDF paper + margins (Typora): Paper Size Default / A5 / A4 /
 * A3 / US Letter / US Legal / Tabloid / Custom ("Width x Height", mm); Margin Default
 * (45/36 pt) or Custom (Top / Bottom / Left / Right, mm). No orientation here.
 */
export function pdfPaperFields(initial: PageSetup, onChange: (p: PageSetup) => void): HTMLElement {
  let page = migratePageSetup(initial);
  const paper = h('select.select', { 'data-page': 'paper' }, ...PAPER_LABELS.map(([v, l]) => h('option', { value: v, text: l })));
  paper.value = page.paper;
  const cw = mmInput('customWidth', page.custom[0], 50, 2000);
  const ch = mmInput('customHeight', page.custom[1], 50, 2000);
  const custom = h('span.inline.page-custom', null, cw, h('span.unit', { text: 'x' }), ch, h('span.unit', { text: 'mm' }));
  const marginMode = h('select.select', { 'data-page': 'marginMode' }, h('option', { value: 'default', text: 'Default' }), h('option', { value: 'custom', text: 'Custom' }));
  marginMode.value = page.marginMode;
  const m = page.margins;
  const mt = mmInput('marginTop', m.top);
  const mb = mmInput('marginBottom', m.bottom);
  const ml = mmInput('marginLeft', m.left);
  const mr = mmInput('marginRight', m.right);
  const mm = (el: HTMLElement, label: string): HTMLElement => h('span.inline', null, h('span.unit', { text: label }), el, h('span.unit', { text: 'mm' }));
  const marginBox = h('span.page-margins', null, mm(mt, 'Top'), mm(mb, 'Bottom'), mm(ml, 'Left'), mm(mr, 'Right'));
  const sync = (): void => {
    custom.hidden = page.paper !== 'custom';
    marginBox.hidden = page.marginMode !== 'custom';
  };
  const read = (): void => {
    page = migratePageSetup({
      paper: paper.value as PaperName,
      custom: [Number(cw.value), Number(ch.value)],
      orientation: page.orientation,
      marginMode: marginMode.value,
      margins: { top: Number(mt.value), right: Number(mr.value), bottom: Number(mb.value), left: Number(ml.value) },
    });
    sync();
    onChange(page);
  };
  for (const el of [paper, cw, ch, marginMode, mt, mr, mb, ml]) el.addEventListener('change', read);
  sync();
  return h('div.page-setup-fields', null, row('Paper Size', paper, custom), row('Margin', marginMode, marginBox));
}

/** File › Page Setup fields: paper + orientation (session; margins live in Preferences). */
function printSetupFields(initial: PrintSetup, onChange: (p: PrintSetup) => void): HTMLElement {
  let ps = migratePrintSetup(initial);
  const paper = h('select.select', { 'data-page': 'paper' }, ...PAPER_LABELS.filter(([v]) => v !== 'default').map(([v, l]) => h('option', { value: v, text: l })));
  paper.value = ps.paper;
  const cw = mmInput('customWidth', ps.custom[0], 50, 2000);
  const ch = mmInput('customHeight', ps.custom[1], 50, 2000);
  const custom = h('span.inline.page-custom', null, cw, h('span.unit', { text: 'x' }), ch, h('span.unit', { text: 'mm' }));
  const orient = h('select.select', { 'data-page': 'orientation' }, h('option', { value: 'portrait', text: 'Portrait' }), h('option', { value: 'landscape', text: 'Landscape' }));
  orient.value = ps.orientation;
  const size = h('span.pref-hint.page-size');
  const sync = (): void => {
    custom.hidden = ps.paper !== 'custom';
    const [w, hh] = paperSizeMm(ps);
    size.textContent = `${Math.round(w * 10) / 10} × ${Math.round(hh * 10) / 10} mm`;
  };
  const read = (): void => {
    ps = migratePrintSetup({ paper: paper.value, custom: [Number(cw.value), Number(ch.value)], orientation: orient.value });
    sync();
    onChange(ps);
  };
  for (const el of [paper, cw, ch, orient]) el.addEventListener('change', read);
  sync();
  return h('div.page-setup-fields', null, row('Paper Size', paper, custom, size), row('Orientation', orient));
}

/**
 * File › Page Setup: like Typora's system page-layout panel it only changes the
 * session's paper + orientation and writes no export setting. A non-Default paper in
 * Preferences › Export › PDF still wins for PDF export. Resolves null when cancelled.
 */
export function openPageSetup(current: PrintSetup): Promise<PrintSetup | null> {
  return new Promise((resolve) => {
    let ps = current;
    let done = false;
    const finish = (v: PrintSetup | null): void => {
      if (done) return;
      done = true;
      modal.close();
      resolve(v);
    };
    const fields = printSetupFields(current, (p) => (ps = p));
    const body = h(
      'div.dialog.page-setup',
      null,
      h('h2.dialog-title', { text: 'Page Setup' }),
      h('p.dialog-message', { text: 'Paper size and orientation for printing and PDF export. A paper size chosen in Preferences › Export › PDF takes precedence.' }),
      fields,
      h(
        'div.dialog-buttons',
        null,
        h('button.btn', { type: 'button', 'data-id': 'reset', text: 'Defaults', onclick: () => finish(migratePrintSetup(DEFAULT_PRINT_SETUP)) }),
        h('button.btn', { type: 'button', 'data-id': 'cancel', text: 'Cancel', onclick: () => finish(null) }),
        h('button.btn.btn-primary', { type: 'button', 'data-id': 'ok', text: 'OK', onclick: () => finish(ps) }),
      ),
    );
    const modal = openModal(body, { className: 'dialog-card', onDismiss: () => finish(null), label: 'Page Setup' });
    (fields.querySelector('select') as HTMLSelectElement | null)?.focus();
  });
}

/**
 * The "Exporting..." sheet shown while Pandoc or a custom export command runs (#90):
 * message "Exporting in progress...", detail "This may take some time...", a single
 * "Abort" button that Return does not trigger. Not shown for PDF export. Escape and
 * backdrop clicks do nothing (only Abort or the end of the task close it).
 * Returns the close function (idempotent).
 */
export function openExportingSheet(abort?: () => void): () => void {
  let closed = false;
  const close = (): void => {
    if (closed) return;
    closed = true;
    modal.close();
  };
  const body = h(
    'div.dialog.export-progress',
    { tabindex: '-1' },
    h('h2.dialog-title', { text: 'Exporting...' }),
    h('p.dialog-message', { text: 'Exporting in progress...' }),
    h('p.dialog-detail', { text: 'This may take some time...' }),
    abort
      ? h(
          'div.dialog-buttons',
          null,
          h('button.btn', {
            type: 'button',
            'data-id': 'abort',
            text: 'Abort',
            onclick: () => {
              close();
              abort();
            },
          }),
        )
      : null,
  );
  // Return must not press Abort: keep focus on the sheet itself, not the button.
  body.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') e.preventDefault();
  });
  const modal = openModal(body, { className: 'dialog-card', label: 'Exporting...', dismissable: false });
  body.focus();
  return close;
}
