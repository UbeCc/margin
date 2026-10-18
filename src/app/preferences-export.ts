/**
 * Preferences › Export (#95, `typora.export.settings`): general export behaviour
 * plus per-format options (PDF, HTML, HTML without styles, Image).
 */
import { themeLabel } from '../themes';
import { CUSTOM_EXPORT_TEMPLATES, migrateExportSettings, type CustomExport, type ExportSettings } from './export-settings';
import { confirmDialog } from './ui/modal';
import { pageSetupFields } from './export-ui';
import { h, debounce } from './util/dom';

export interface ExportPrefsHost {
  get(): ExportSettings;
  set(next: ExportSettings): void;
  themeNames(): string[];
  pickFolder(): Promise<string | null>;
}

type Fmt = 'general' | 'pdf' | 'html' | 'htmlPlain' | 'image';

export function exportPrefsSection(host: ExportPrefsHost): HTMLElement {
  // Every control patches one path of the settings object and saves the whole thing.
  const patch = (fmt: Fmt, key: string, value: unknown): void => {
    const cur = host.get();
    host.set(migrateExportSettings({ ...cur, [fmt]: { ...cur[fmt], [key]: value } }));
  };
  const row = (label: string, control: HTMLElement, hint?: string): HTMLElement =>
    h('label.pref-row', null, h('span.pref-label', null, label, hint ? h('span.pref-hint', { text: hint }) : null), h('span.pref-control', null, control));
  const sel = (fmt: Fmt, key: string, options: [string, string][]): HTMLSelectElement => {
    const el = h('select.select', { 'data-export': `${fmt}.${key}` }, ...options.map(([v, l]) => h('option', { value: v, text: l })));
    el.value = String((host.get()[fmt] as unknown as Record<string, unknown>)[key]);
    el.addEventListener('change', () => patch(fmt, key, el.value));
    return el;
  };
  const check = (fmt: Fmt, key: string): HTMLInputElement => {
    const el = h('input.switch', { type: 'checkbox', role: 'switch', 'data-export': `${fmt}.${key}` });
    el.checked = Boolean((host.get()[fmt] as unknown as Record<string, unknown>)[key]);
    el.addEventListener('change', () => patch(fmt, key, el.checked));
    return el;
  };
  const text = (fmt: Fmt, key: string, placeholder = '', multiline = false): HTMLElement => {
    const el = multiline
      ? h('textarea.css-input', { rows: '3', spellcheck: 'false', placeholder, 'data-export': `${fmt}.${key}` })
      : h('input.text-input', { type: 'text', spellcheck: 'false', placeholder, 'data-export': `${fmt}.${key}` });
    el.value = String((host.get()[fmt] as unknown as Record<string, unknown>)[key] ?? '');
    const save = debounce(() => patch(fmt, key, el.value), 300);
    el.addEventListener('input', save);
    el.addEventListener('change', () => save.flush());
    el.addEventListener('blur', () => save.flush());
    return el;
  };
  const num = (fmt: Fmt, key: string, min: number, max: number, unit: string): HTMLElement => {
    const el = h('input.number', { type: 'number', min: String(min), max: String(max), step: '1', 'data-export': `${fmt}.${key}` });
    el.value = String((host.get()[fmt] as unknown as Record<string, unknown>)[key]);
    el.addEventListener('change', () => {
      const v = Number(el.value);
      if (v >= min && v <= max) patch(fmt, key, v);
    });
    return h('span.inline', null, el, h('span.unit', { text: unit }));
  };
  const themes: [string, string][] = [['', 'Current theme'], ...host.themeNames().map((n): [string, string] => [n, themeLabel(n)])];
  const heading = (t: string): HTMLElement => h('h3.pref-subhead', { text: t });

  const customFolder = text('general', 'customFolder', '/path/to/exports');
  const browse = h('button.btn.btn-small', {
    type: 'button',
    text: 'Choose…',
    onclick: async () => {
      const p = await host.pickFolder();
      if (!p) return;
      (customFolder as HTMLInputElement).value = p;
      const cur = host.get();
      host.set(migrateExportSettings({ ...cur, general: { ...cur.general, customFolder: p, folder: 'custom' } }));
      folder.value = 'custom';
    },
  });
  const folder = sel('general', 'folder', [
    ['same', 'Same folder as the document'],
    ['last', 'Last used export folder'],
    ['custom', 'Custom folder…'],
  ]);

  const vars = 'Variables: ${title} ${author} ${today} ${currentFileName} ${pageNo} ${totalPages}';
  return h(
    'section.pref-section',
    { 'data-section': 'export' },
    heading('General'),
    row('Default Folder for Exported File', folder),
    row('Custom folder', h('span.inline', null, customFolder, browse)),
    row('After Export', sel('general', 'afterExport', [['none', 'Do nothing'], ['open', 'Open exported file'], ['reveal', 'Reveal in folder']])),
    row('Allow YAML front matter to override export settings', check('general', 'allowYamlOverrides'), 'title, author, subject, keywords, header, footer'),
    row('Do not warn before “Export and Overwrite with Previous”', check('general', 'noOverwriteWarning')),
    row('Run command after export', text('general', 'runAfterExport', 'open -R ${outputPath}'), 'Executable and arguments; no shell. ${outputPath} ${outputFolder} ${currentPath} …'),
    heading('PDF'),
    pageSetupFields(host.get().pdf.page, (page) => patch('pdf', 'page', page)),
    row('Theme', sel('pdf', 'theme', themes)),
    row('Page Breaks', sel('pdf', 'pageBreaks', [['none', 'None'], ['h1', 'Before each Heading 1'], ['h2', 'Before each Heading 1 and 2']])),
    row('Header', text('pdf', 'header', '${title}'), vars),
    row('Footer', text('pdf', 'footer', '${pageNo} / ${totalPages}')),
    row('Bookmarks (outline from headings)', check('pdf', 'outline')),
    row('Author', text('pdf', 'author')),
    heading('HTML'),
    row('Theme', sel('html', 'theme', themes)),
    row('Append in <head>', text('html', 'appendHead', '<meta name="robots" content="noindex">', true)),
    row('Append in <body>', text('html', 'appendBody', '', true)),
    heading('HTML (without Styles)'),
    row('Append in <head>', text('htmlPlain', 'appendHead', '<link rel="stylesheet" href="style.css">', true)),
    row('Append in <body>', text('htmlPlain', 'appendBody', '', true)),
    heading('Image'),
    row('Image Format', sel('image', 'format', [['png', 'PNG'], ['jpeg', 'JPEG']])),
    row('Image Quality', sel('image', 'quality', [['medium', 'Medium'], ['high', 'High'], ['best', 'Best (2×)']])),
    row('Image Width', num('image', 'width', 200, 4000, 'px')),
    row('Font Size', num('image', 'fontSize', 8, 48, 'px')),
    row('Theme', sel('image', 'theme', themes)),
    heading('Custom Export Commands'),
    customExportsEditor(host),
  );
}

/** Add / edit / delete custom export commands (File › Export › Custom…). */
function customExportsEditor(host: ExportPrefsHost): HTMLElement {
  const list = h('div.custom-exports');
  const save = (next: CustomExport[]): void => {
    host.set(migrateExportSettings({ ...host.get(), custom: next }));
    render();
  };
  const update = (id: string, patch: Partial<CustomExport>): void => {
    host.set(migrateExportSettings({ ...host.get(), custom: host.get().custom.map((c) => (c.id === id ? { ...c, ...patch } : c)) }));
  };
  const add = (tpl: Omit<CustomExport, 'id'>): void => save([...host.get().custom, { ...tpl, id: `c${Date.now().toString(36)}` }]);
  const render = (): void => {
    list.replaceChildren(
      ...host.get().custom.map((c) => {
        const field = (key: 'name' | 'command' | 'extension', ph: string): HTMLInputElement => {
          const el = h('input.text-input', { type: 'text', spellcheck: 'false', placeholder: ph, value: c[key], 'data-custom': key });
          el.addEventListener('change', () => update(c.id, { [key]: el.value } as Partial<CustomExport>));
          return el;
        };
        const input = h('select.select', { 'data-custom': 'input' }, h('option', { value: 'markdown', text: 'Markdown on stdin' }), h('option', { value: 'html', text: 'HTML on stdin' }));
        input.value = c.input;
        input.addEventListener('change', () => update(c.id, { input: input.value as CustomExport['input'] }));
        const dlg = h('input', { type: 'checkbox', 'data-custom': 'saveDialog' });
        dlg.checked = c.saveDialog;
        dlg.addEventListener('change', () => update(c.id, { saveDialog: dlg.checked }));
        const del = h('button.btn.btn-small.btn-danger', {
          type: 'button',
          text: 'Delete',
          'data-custom': 'delete',
          onclick: async () => {
            if (await confirmDialog('Delete this export option?', c.name, 'Delete', true)) save(host.get().custom.filter((x) => x.id !== c.id));
          },
        });
        return h(
          'div.custom-export',
          { 'data-id': c.id },
          h('div.inline', null, field('name', 'Name'), field('extension', 'ext'), del),
          field('command', 'Executable and arguments, e.g. pandoc -o ${outputPath}'),
          h('div.inline', null, input, h('label.inline', null, dlg, h('span', { text: 'Ask for output file' }))),
        );
      }),
    );
  };
  const tpl = h('select.select', { 'data-custom': 'template' }, h('option', { value: '', text: 'Add From a Template…' }), ...CUSTOM_EXPORT_TEMPLATES.map((t, i) => h('option', { value: String(i), text: t.name })));
  tpl.addEventListener('change', () => {
    const t = CUSTOM_EXPORT_TEMPLATES[Number(tpl.value)];
    tpl.value = '';
    if (t) add(t);
  });
  render();
  return h(
    'div.pref-block',
    null,
    list,
    h(
      'div.pref-actions',
      null,
      h('button.btn', { type: 'button', text: 'Add', 'data-custom': 'add', onclick: () => add({ name: 'New export', command: '', extension: 'txt', input: 'markdown', saveDialog: true }) }),
      tpl,
    ),
    h('p.pref-note', { text: 'Commands run without a shell: the line is split into arguments first, then ${outputPath}, ${outputFolder}, ${currentPath}, ${currentFolder}, ${title}, ${today}… are filled into each argument.' }),
  );
}
