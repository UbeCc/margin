import type { ImageRule } from '../contracts';
import { themeLabel } from '../themes';
import { IMAGE_RULE_PRESETS, imageRulePresetId, type MarginSettings } from './settings';
import { h, debounce } from './util/dom';
import { confirmDialog, openModal } from './ui/modal';
import { uploadPrefsSection } from './upload-prefs';
import { prefKit } from './prefs/kit';
import { generalPane } from './prefs/general';
import { editorPane, markdownPane } from './prefs/editor-md';

export interface PreferencesHost {
  settings(): MarginSettings;
  update(patch: Partial<MarginSettings>): void;
  themeNames(): string[];
  isDarkTheme(name: string): boolean;
  openThemesFolder(): void;
  pickFolder(): Promise<string | null>;
  /** Locate pandoc for the given path ('' = auto); resolves to a status line, never rejects. */
  detectPandoc?(path: string): Promise<string>;
}

/** Pane order follows Typora: General, Appearance, Editor, Image, Markdown, Export (#100). */
export type Section = 'general' | 'appearance' | 'editor' | 'images' | 'markdown' | 'export';

let openHandle: { close(): void } | null = null;

export function openPreferences(host: PreferencesHost, initial: Section = 'general'): void {
  if (openHandle) return;
  const s = host.settings();
  const set = (patch: Partial<MarginSettings>): void => host.update(patch);
  const kit = prefKit(() => host.settings(), set);

  const row = (label: string, control: HTMLElement, hint?: string): HTMLElement =>
    h('label.pref-row', null, h('span.pref-label', null, label, hint ? h('span.pref-hint', { text: hint }) : null), h('span.pref-control', null, control));

  const toggle = (key: keyof MarginSettings, label: string, hint?: string): HTMLElement => {
    const input = h('input.switch', { type: 'checkbox', role: 'switch', 'data-pref': key });
    input.checked = Boolean(s[key]);
    input.addEventListener('change', () => set({ [key]: input.checked } as Partial<MarginSettings>));
    return row(label, input, hint);
  };

  const select = (key: string, options: [string, string][], value: string, onChange: (v: string) => void): HTMLSelectElement => {
    const el = h('select.select', { 'data-pref': key }, ...options.map(([v, l]) => h('option', { value: v, text: l })));
    el.value = value;
    el.addEventListener('change', () => onChange(el.value));
    return el;
  };

  // ---------------------------------------------------------------- appearance
  const names = host.themeNames();
  const darkNames = names.filter((n) => host.isDarkTheme(n));
  const fontSize = h('input.number', { type: 'number', min: '10', max: '32', step: '1', value: String(s.fontSize), 'data-pref': 'fontSize' });
  fontSize.addEventListener('change', () => {
    const v = Math.round(Number(fontSize.value));
    if (v >= 10 && v <= 32) set({ fontSize: v });
  });
  const columnWidth = h('input.number', {
    type: 'number',
    min: '400',
    max: '3000',
    step: '10',
    placeholder: 'Default',
    value: s.textColumnWidth ? String(s.textColumnWidth) : '',
    'data-pref': 'textColumnWidth',
  });
  columnWidth.addEventListener('change', () => {
    const v = columnWidth.value.trim() ? Math.round(Number(columnWidth.value)) : 0;
    if (v === 0 || (v >= 400 && v <= 3000)) set({ textColumnWidth: v });
  });
  const customCss = h('textarea.css-input', { rows: '6', spellcheck: 'false', placeholder: '.margin-doc h1 { letter-spacing: 0.02em; }', 'data-pref': 'customCss' });
  customCss.value = s.customCss;
  const saveCss = debounce(() => set({ customCss: customCss.value }), 400);
  customCss.addEventListener('input', saveCss);
  customCss.addEventListener('blur', () => saveCss.flush());

  const appearance = h(
    'section.pref-section',
    { 'data-section': 'appearance' },
    row(
      'Theme',
      // Light themes only: dark ones are picked below (a dark "Theme" in a light OS would silently fall back).
      select('theme', names.filter((n) => !host.isDarkTheme(n) || n === s.theme).map((n) => [n, themeLabel(n)]), s.theme, (v) => set({ theme: v })),
    ),
    row(
      'Appearance',
      select('colorScheme', [['system', 'Match System'], ['light', 'Light'], ['dark', 'Dark']], s.colorScheme, (v) =>
        set({ colorScheme: v as MarginSettings['colorScheme'] }),
      ),
    ),
    row(
      'Dark theme',
      select('darkTheme', (darkNames.length ? darkNames : ['night']).map((n) => [n, themeLabel(n)]), s.darkTheme, (v) => set({ darkTheme: v })),
      'Used in dark mode when the theme above is light',
    ),
    row('Font size', h('span.inline', null, fontSize, h('span.unit', { text: 'px' }))),
    row(
      'Window Style',
      select('windowStyle', [['seamless', 'Seamless'], ['unibody', 'Unibody'], ['native', 'System Native']], s.windowStyle, (v) =>
        set({ windowStyle: v as MarginSettings['windowStyle'] }),
      ),
      '(applied after restart; desktop only)',
    ),
    row('Text Column Width', h('span.inline', null, columnWidth, h('span.unit', { text: 'px' })), 'Empty = theme default'),
    h(
      'div.pref-group',
      { 'data-group': 'Left Panel' },
      h('h3.pref-group-title', { text: 'Left Panel' }),
      toggle('showOutlineByDefault', 'Show Outline Panel by Default'),
      toggle('collapsibleOutline', 'Collapsible Outline on Left Panel'),
    ),
    h('div.pref-block', null, h('div.pref-label', null, 'Custom CSS', h('span.pref-hint', { text: 'Applied on top of the theme' })), customCss),
    h('div.pref-actions', null, h('button.btn', { type: 'button', text: 'Open Themes Folder', onclick: () => host.openThemesFolder() })),
  );

  // ---------------------------------------------------------------- export
  const pandocPath = h('input.text-input', { type: 'text', placeholder: 'Auto-detect', value: s.pandocPath, spellcheck: 'false', 'data-pref': 'pandocPath' });
  pandocPath.addEventListener('change', () => set({ pandocPath: pandocPath.value.trim() }));
  const pandocStatus = h('span.pref-hint', { 'data-pref-status': 'pandoc' });
  const detect = host.detectPandoc;
  const pandocDetect = detect
    ? h('button.btn', {
        type: 'button',
        text: 'Detect',
        onclick: () => {
          pandocStatus.textContent = 'Checking…';
          void detect(pandocPath.value.trim()).then(
            (m) => (pandocStatus.textContent = m),
            (e: unknown) => (pandocStatus.textContent = String(e)),
          );
        },
      })
    : null;
  const exportPane = h(
    'section.pref-section',
    { 'data-section': 'export' },
    row('Pandoc Path', h('span.inline', null, pandocPath, pandocDetect), 'Used for Word, LaTeX and EPUB export'),
    h('div.pref-block', null, pandocStatus),
  );

  // ---------------------------------------------------------------- images
  const current = imageRulePresetId(s.imageRule);
  const absDir = h('input.text-input', {
    type: 'text',
    placeholder: '/path/to/images',
    value: s.imageRule.kind === 'absolute' ? s.imageRule.dir : '',
    'data-pref': 'imageAbsDir',
  });
  const relDir = h('input.text-input', {
    type: 'text',
    placeholder: './images',
    value: current === 'custom' && s.imageRule.kind === 'relative' ? s.imageRule.dir : '',
    'data-pref': 'imageRelDir',
  });
  const radios: HTMLInputElement[] = [];
  const presets = [...IMAGE_RULE_PRESETS.slice(0, 2), { id: 'custom', label: 'Copy to relative folder…', rule: { kind: 'relative', dir: '' } as ImageRule }, ...IMAGE_RULE_PRESETS.slice(2)];
  const applyRule = (): void => {
    const id = radios.find((r) => r.checked)?.value;
    const preset = presets.find((p) => p.id === id);
    if (!preset) return;
    let rule: ImageRule = preset.rule;
    if (id === 'absolute') {
      if (!absDir.value.trim()) return;
      rule = { kind: 'absolute', dir: absDir.value.trim() };
    } else if (id === 'custom') {
      if (!relDir.value.trim()) return;
      const d = relDir.value.trim();
      rule = { kind: 'relative', dir: d.startsWith('.') ? d : `./${d}` };
    }
    set({ imageRule: rule });
  };
  const browse = h('button.btn.btn-small', {
    type: 'button',
    text: 'Choose…',
    onclick: async () => {
      const p = await host.pickFolder();
      if (p) {
        absDir.value = p;
        radios.find((r) => r.value === 'absolute')!.checked = true;
        applyRule();
      }
    },
  });
  const images = h(
    'section.pref-section',
    { 'data-section': 'images' },
    h('div.pref-label', { text: 'When inserting or pasting images' }),
    h(
      'div.radio-group',
      { role: 'radiogroup' },
      ...presets.map((p) => {
        const r = h('input', { type: 'radio', name: 'imageRule', value: p.id });
        r.checked = p.id === current;
        r.addEventListener('change', applyRule);
        radios.push(r);
        const extra = p.id === 'absolute' ? h('span.inline', null, absDir, browse) : p.id === 'custom' ? relDir : null;
        return h('label.radio', null, r, h('span', { text: p.label }), extra);
      }),
    ),
    h('p.pref-note', { text: '${filename} is replaced with the document name. Unsaved documents keep images where they are until saved.' }),
    uploadPrefsSection(s, (p) => set(p as Partial<MarginSettings>)),
  );
  absDir.addEventListener('change', applyRule);
  relDir.addEventListener('change', applyRule);

  // ---------------------------------------------------------------- shell
  const sections: Record<Section, [string, HTMLElement]> = {
    general: ['General', generalPane(kit, { pickFolder: () => host.pickFolder(), confirm: (t, m) => confirmDialog(t, m, 'Revert', true) })],
    appearance: ['Appearance', appearance],
    editor: ['Editor', editorPane(kit)],
    images: ['Image', images],
    markdown: ['Markdown', markdownPane(kit)],
    export: ['Export', exportPane],
  };
  const nav = h('nav.pref-nav', { role: 'tablist' });
  const panel = h('div.pref-panel');
  const show = (id: Section): void => {
    panel.replaceChildren(sections[id][1]);
    for (const b of nav.querySelectorAll('button')) b.setAttribute('aria-selected', String(b.dataset.section === id));
  };
  for (const [id, [label]] of Object.entries(sections) as [Section, [string, HTMLElement]][]) {
    nav.appendChild(h('button.pref-tab', { type: 'button', role: 'tab', 'data-section': id, text: label, onclick: () => show(id) }));
  }
  const body = h(
    'div.preferences',
    null,
    h('header.pref-header', null, h('h2', { text: 'Preferences' }), h('button.icon-btn.pref-close', { type: 'button', 'aria-label': 'Close', text: '×', onclick: () => close() })),
    h('div.pref-body', null, nav, panel),
  );
  show(initial);
  const modal = openModal(body, { className: 'pref-card', label: 'Preferences', onDismiss: () => (openHandle = null) });
  const close = (): void => {
    saveCss.flush();
    modal.close();
    openHandle = null;
  };
  openHandle = { close };
  (nav.querySelector('button[aria-selected="true"]') as HTMLButtonElement | null)?.focus();
}
