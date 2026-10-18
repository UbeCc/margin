import type { UploadConfig } from '../contracts';
import type { UploaderTestReport } from './platform-extras';
import { themeLabel } from '../themes';
import type { MarginSettings } from './settings';
import { h, debounce } from './util/dom';
import { confirmDialog, openModal } from './ui/modal';
import { exportPrefsSection } from './preferences-export';
import { uploadPrefsSection } from './upload-prefs';
import { prefKit } from './prefs/kit';
import { generalPane } from './prefs/general';
import { editorPane, markdownPane } from './prefs/editor-md';
import { imageRulesSection } from './images/prefs';

export interface PreferencesHost {
  settings(): MarginSettings;
  update(patch: Partial<MarginSettings>): void;
  themeNames(): string[];
  isDarkTheme(name: string): boolean;
  openThemesFolder(): void;
  pickFolder(): Promise<string | null>;
  /** File picker limited to `extensions` (Pandoc Style Reference / Template / Custom CSS). */
  pickFile?(name: string, extensions: string[]): Promise<string | null>;
  /** Locate pandoc for the given path ('' = auto); resolves to a status line, never rejects. */
  detectPandoc?(path: string): Promise<string>;
  /** General › Recover Unsaved Drafts (#94). */
  recoverDrafts?(): void;
  /** #92: Preferences › Images › Test Uploader (desktop). */
  testUploader?(config: UploadConfig): Promise<UploaderTestReport>;
}

/** Pane order follows Typora: General, Appearance, Editor, Image, Markdown, Export (#100). */
export type Section = 'general' | 'appearance' | 'editor' | 'images' | 'markdown' | 'export';

let openHandle: { close(): void } | null = null;

export function openPreferences(host: PreferencesHost, initial: Section = 'general', deepLink?: string): void {
  if (openHandle) return;
  const s = host.settings();
  const set = (patch: Partial<MarginSettings>): void => host.update(patch);
  const kit = prefKit(() => host.settings(), set);

  const row = (label: string, control: HTMLElement, hint?: string): HTMLElement =>
    h('label.pref-row', null, h('span.pref-label', null, label, hint ? h('span.pref-hint', { text: hint }) : null), h('span.pref-control', null, control));

  const select = (key: string, options: [string, string][], value: string, onChange: (v: string) => void): HTMLSelectElement => {
    const el = h('select.select', { 'data-pref': key }, ...options.map(([v, l]) => h('option', { value: v, text: l })));
    el.value = value;
    el.addEventListener('change', () => onChange(el.value));
    return el;
  };

  // ---------------------------------------------------------------- appearance (fe-preferences §4)
  const names = host.themeNames();
  const darkNames = names.filter((n) => host.isDarkTheme(n));
  // Font Size: "Auto ( Recommended )" / "Customized" + 9–24 px box, clamped on blur (#134).
  const sizeBox = h('input.number', { type: 'number', min: '9', max: '24', step: '1', value: String(s.customFontSize), 'data-pref': 'fontSize', 'aria-label': 'Font size in px' });
  const applyFontSize = (): void => {
    const v = Math.max(9, Math.min(24, Math.round(Number(sizeBox.value) || 14)));
    sizeBox.value = String(v);
    set({ customFontSize: v, useCustomFontSize: true, fontSize: v });
  };
  sizeBox.addEventListener('change', applyFontSize);
  sizeBox.addEventListener('blur', applyFontSize);
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
  // Reading Speed: 1–999 words/min, default 382; presets 120 / 240 / 382 (fe-preferences §4.3).
  const wpmBox = h('input.number', { type: 'number', min: '1', max: '999', step: '1', value: String(s.wordsPerMinute), 'data-pref': 'wordsPerMinute' });
  wpmBox.addEventListener('change', () => {
    const v = Math.max(1, Math.min(999, Math.round(Number(wpmBox.value) || 382)));
    wpmBox.value = String(v);
    set({ wordsPerMinute: v });
  });
  const wpmReset = h('button.btn', { type: 'button', text: 'Reset to Default', onclick: () => { wpmBox.value = '382'; set({ wordsPerMinute: 382 }); } });
  const wpmPreset = select('wordsPerMinutePreset', [['', 'Presets…'], ['120', '120  words/minute (Slow)'], ['240', '240  words/minute (Medium)'], ['382', '382  words/minute (Fast)']], '', (v) => {
    if (!v) return;
    wpmBox.value = v;
    set({ wordsPerMinute: Number(v) });
  });

  const appearance = h(
    'section.pref-section',
    { 'data-section': 'appearance' },
    kit.group(
      'Window Style',
      row(
        'Window Style',
        select('windowStyle', [['seamless', 'Seamless'], ['unibody', 'Unibody'], ['native', 'Classic']], s.windowStyle, (v) => set({ windowStyle: v as MarginSettings['windowStyle'] })),
        '(applied after restart; desktop only)',
      ),
    ),
    kit.group(
      'Font Size',
      row(
        'Font Size',
        kit.radios(
          'useCustomFontSize',
          [['auto', 'Auto ( Recommended )'], ['custom', 'Customized']],
          s.useCustomFontSize ? 'custom' : 'auto',
          (v) => set(v === 'custom' ? { useCustomFontSize: true, fontSize: s.customFontSize } : { useCustomFontSize: false, fontSize: 16 }),
          { custom: h('span.inline', null, sizeBox, h('span.unit', { text: 'px' })) },
        ),
      ),
    ),
    kit.group(
      'Word Count',
      kit.toggle('alwaysShowWordCount', 'Always Show Word Count'),
      row('Reading Speed', h('span.inline', null, wpmBox, h('span.unit', { text: 'words / min' }), wpmPreset, wpmReset)),
      kit.toggle('statusBarVisible', 'Show status bar'),
    ),
    kit.group('Left Panel', kit.toggle('showOutlineByDefault', 'Show Outline Panel by Default'), kit.toggle('collapsibleOutline', 'Collapsible Outline on Left Panel')),
    kit.group(
      'Themes',
      row(
        'Theme',
        // Light themes only: dark ones are picked below (a dark "Theme" in a light OS would silently fall back).
        select('theme', names.filter((n) => !host.isDarkTheme(n) || n === s.theme).map((n) => [n, themeLabel(n)]), s.theme, (v) => set({ theme: v })),
      ),
      row('Appearance', select('colorScheme', [['system', 'Match System'], ['light', 'Light'], ['dark', 'Dark']], s.colorScheme, (v) => set({ colorScheme: v as MarginSettings['colorScheme'] }))),
      row('Dark theme', select('darkTheme', (darkNames.length ? darkNames : ['night']).map((n) => [n, themeLabel(n)]), s.darkTheme, (v) => set({ darkTheme: v })), 'Used in dark mode when the theme above is light'),
      row('Text Column Width', h('span.inline', null, columnWidth, h('span.unit', { text: 'px' })), 'Empty = theme default'),
      h('div.pref-block', null, h('div.pref-label', null, 'Custom CSS', h('span.pref-hint', { text: 'Applied on top of the theme' })), customCss),
      h('div.pref-actions', null, h('button.btn', { type: 'button', text: 'Open Themes Folder', onclick: () => host.openThemesFolder() })),
    ),
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
    { 'data-section': 'export-pandoc', 'data-pref-group': 'pandoc' },
    row('Pandoc Path', h('span.inline', null, pandocPath, pandocDetect), 'Used for Word, LaTeX and EPUB export'),
    h('div.pref-block', null, pandocStatus),
  );

  // ---------------------------------------------------------------- images (#99, src/app/images/prefs.ts)
  const images = h(
    'section.pref-section',
    { 'data-section': 'images' },
    imageRulesSection(s, (p) => set(p as Partial<MarginSettings>), () => host.pickFolder()),
    uploadPrefsSection(s, (p) => set(p as Partial<MarginSettings>), host.testUploader),
  );

  // ---------------------------------------------------------------- shell
  const sections: Record<Section, [string, HTMLElement]> = {
    general: ['General', generalPane(kit, { pickFolder: () => host.pickFolder(), confirm: (t, m) => confirmDialog(t, m, 'Revert', true), ...(host.recoverDrafts ? { recoverDrafts: () => (close(), host.recoverDrafts!()) } : {}) })],
    appearance: ['Appearance', appearance],
    editor: ['Editor', editorPane(kit)],
    images: ['Image', images],
    markdown: ['Markdown', markdownPane(kit)],
    // Export: Pandoc Path (#81) + the export settings pane (#110/#118/#128)
    export: [
      'Export',
      h(
        'div.pref-export-wrap',
        null,
        exportPane,
        exportPrefsSection({
          get: () => host.settings().export,
          set: (next) => set({ export: next }),
          themeNames: () => host.themeNames(),
          pickFolder: () => host.pickFolder(),
          pickFile: host.pickFile ? (n, e) => host.pickFile!(n, e) : undefined,
        }),
      ),
    ],
};
  const nav = h('nav.pref-nav', { role: 'tablist' });
  const panel = h('div.pref-panel');
  const show = (id: Section): void => {
    panel.replaceChildren(sections[id][1]);
    for (const b of nav.querySelectorAll('button')) b.setAttribute('aria-selected', String(b.dataset.section === id));
    runSearch(searchBox.value);
  };
  for (const [id, [label]] of Object.entries(sections) as [Section, [string, HTMLElement]][]) {
    nav.appendChild(h('button.pref-tab', { type: 'button', role: 'tab', 'data-section': id, onclick: () => show(id) }, h('span', { text: label }), h('span.pref-hits', { 'data-hits': '' })));
  }
  // Search box (fe-preferences §1): case-insensitive substring match over each
  // group's title, hints and extra keywords; nav tabs show per-pane hit counts.
  const searchBox = h('input.pref-search', { type: 'search', placeholder: 'Search for…', 'aria-label': 'Search preferences' });
  const runSearch = (q: string): void => {
    const needle = q.trim().toLowerCase();
    const counts: Partial<Record<Section, number>> = {};
    for (const [id, [, pane]] of Object.entries(sections) as [Section, [string, HTMLElement]][]) {
      let hits = 0;
      for (const g of pane.querySelectorAll<HTMLElement>('.pref-group, [data-pref-group]')) {
        const hay = `${g.dataset.group ?? ''} ${g.dataset.keywords ?? ''} ${g.textContent ?? ''}`.toLowerCase();
        const hit = needle !== '' && hay.includes(needle);
        g.classList.toggle('pref-hit', hit);
        if (hit) hits++;
      }
      counts[id] = hits;
    }
    for (const b of nav.querySelectorAll<HTMLButtonElement>('button')) {
      const n = counts[b.dataset.section as Section] ?? 0;
      (b.querySelector('.pref-hits') as HTMLElement).dataset.hits = n ? String(n) : '';
    }
  };
  searchBox.addEventListener('input', () => runSearch(searchBox.value));
  /** Deep link (§1): blink the target group for 4 s, then clear. */
  const highlightGroup = (pane: Section, sel: string): void => {
    show(pane);
    const g = sections[pane][1].querySelector<HTMLElement>(sel);
    if (!g) return;
    g.classList.add('pref-deeplink');
    setTimeout(() => g.classList.remove('pref-deeplink'), 4000);
  };
  const body = h(
    'div.preferences',
    null,
    h('header.pref-header', null, h('h2', { text: 'Preferences' }), searchBox, h('button.icon-btn.pref-close', { type: 'button', 'aria-label': 'Close', text: '×', onclick: () => close() })),
    h('div.pref-body', null, nav, panel),
  );
  show(initial);
  if (deepLink) highlightGroup(initial, deepLink);
  const modal = openModal(body, { className: 'pref-card', label: 'Preferences', onDismiss: () => (openHandle = null) });
  const close = (): void => {
    saveCss.flush();
    modal.close();
    openHandle = null;
  };
  openHandle = { close };
  (nav.querySelector('button[aria-selected="true"]') as HTMLButtonElement | null)?.focus();
}
