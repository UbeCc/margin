/** Preferences › General (#100): On Launch, Save & Recover, Language, Advanced Settings. */
import { DEFAULT_SETTINGS, type MarginSettings, type OnLaunch } from '../settings';
import { h } from '../util/dom';
import type { PrefKit } from './kit';

export interface GeneralHost {
  pickFolder(): Promise<string | null>;
  confirm(title: string, message?: string): Promise<boolean>;
  /** Save & Recover › Recover Unsaved Drafts (#94). */
  recoverDrafts?(): void;
}

/** Keys the advanced-settings editor never touches (history / window state). */
const VOLATILE = ['recentFiles', 'recentFolders', 'lastFolder', 'settingsVersion'] as const;

export function generalPane(k: PrefKit, host: GeneralHost): HTMLElement {
  const s = k.cur();
  const folder = h('input.text-input', { type: 'text', placeholder: '/path/to/folder', value: s.defaultFolder, spellcheck: 'false', 'data-pref': 'defaultFolder' });
  folder.addEventListener('change', () => k.set({ defaultFolder: folder.value.trim() }));
  const choose = h('button.btn.btn-small', {
    type: 'button',
    text: 'Choose Default Folder',
    onclick: async () => {
      const p = await host.pickFolder();
      if (!p) return;
      folder.value = p;
      k.set({ defaultFolder: p, onLaunch: 'customFolder' });
      launch.value = 'customFolder';
    },
  });
  const folderRow = h('div.pref-row.pref-subrow', { 'data-pref-row': 'defaultFolder' }, h('span.inline', null, folder, choose));
  const showFolder = () => (folderRow.hidden = launch.value !== 'customFolder');
  // Typora order: 0 Open new file, 1 Restore last closed folders, 2 … files and folders, 3 Open custom folder.
  const launch = k.select(
    'onLaunch',
    [
      ['newFile', 'Open new file'],
      ['restoreFolders', 'Restore last closed folders'],
      ['restoreAll', 'Restore last closed files and folders'],
      ['customFolder', 'Open custom folder'],
    ],
    s.onLaunch,
    async (v) => {
      // Choosing "Open custom folder" without a folder asks for one; cancelling keeps the old choice.
      if (v === 'customFolder' && !k.cur().defaultFolder) {
        const p = await host.pickFolder();
        if (!p) {
          launch.value = k.cur().onLaunch;
          showFolder();
          return;
        }
        folder.value = p;
        k.set({ defaultFolder: p });
      }
      k.set({ onLaunch: v as OnLaunch });
      showFolder();
    },
  );
  showFolder();

  const delay = h('input.number', { type: 'number', min: '0.3', max: '60', step: '0.1', value: String(s.autoSaveDelay / 1000), 'data-pref': 'autoSaveDelay' });
  delay.addEventListener('change', () => {
    const v = Number(delay.value);
    if (v >= 0.3 && v <= 60) k.set({ autoSaveDelay: Math.round(v * 1000) });
  });

  // ---- Advanced Settings: the persisted settings as editable JSON (Margin's "config file").
  const status = h('span.pref-hint', { 'data-pref-status': 'advanced' });
  const json = h('textarea.css-input', { rows: '10', spellcheck: 'false', 'data-pref': 'advancedJson', hidden: '' }) as HTMLTextAreaElement;
  const editable = (): Record<string, unknown> => {
    const o: Record<string, unknown> = { ...k.cur() };
    for (const key of VOLATILE) delete o[key];
    return o;
  };
  const apply = h('button.btn.btn-small', {
    type: 'button',
    text: 'Apply',
    hidden: '',
    onclick: () => {
      try {
        const v = JSON.parse(json.value) as unknown;
        if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error('expected a JSON object');
        k.set(v as Partial<MarginSettings>);
        json.value = JSON.stringify(editable(), null, 2);
        status.textContent = 'Saved';
      } catch (e) {
        status.textContent = `Invalid settings: ${e instanceof Error ? e.message : String(e)}`;
      }
    },
  });
  const openAdvanced = h('button.btn', {
    type: 'button',
    text: 'Open Advanced Settings',
    onclick: () => {
      json.value = JSON.stringify(editable(), null, 2);
      json.hidden = false;
      apply.hidden = false;
      json.focus();
    },
  });
  const reset = h('button.btn', {
    type: 'button',
    text: 'Reset Advanced Settings',
    onclick: async () => {
      if (!(await host.confirm('Reset Advanced Settings', 'Revert advanced setting file to default one ?'))) return;
      const d: Record<string, unknown> = { ...DEFAULT_SETTINGS };
      for (const key of VOLATILE) delete d[key];
      k.set(d as Partial<MarginSettings>);
      if (!json.hidden) json.value = JSON.stringify(editable(), null, 2);
      status.textContent = 'Advanced settings reverted to defaults. Reopen Preferences to see every value.';
    },
  });
  const resetWarnings = h('button.btn', {
    type: 'button',
    text: 'Reset All Dialog Warnings',
    onclick: () => {
      k.set({ dialogWarnings: [] } as unknown as Partial<MarginSettings>);
      status.textContent = 'Dialog warnings have been reset.';
    },
  });
  const clearRecent = h('button.btn', {
    type: 'button',
    text: 'Clear Recent Files',
    onclick: (e: Event) => {
      k.set({ recentFiles: [], recentFolders: [] });
      (e.currentTarget as HTMLButtonElement).textContent = 'Cleared';
    },
  });

  const pane = h(
    'section.pref-section',
    { 'data-section': 'general' },
    k.group('On Launch', k.row('On Launch', launch), folderRow),
    k.group('Quit', k.toggle('quitOnLastWindowClose', 'Quit Margin when last window is closed', '(applied after restart)')),
    k.group(
      'Save & Recover',
      k.toggle('autoSave', 'Auto Save', 'Save documents automatically after you stop typing'),
      k.row('Auto-save delay', h('span.inline', null, delay, h('span.unit', { text: 's' }))),
      k.toggle('saveOnSwitch', 'Save without asking when switch files on side panel', 'Switching documents from the sidebar saves the current one (#94)'),
      host.recoverDrafts
        ? k.row(
            'Unsaved drafts',
            h('button.btn', { type: 'button', 'data-pref': 'recoverDrafts', text: 'Recover Unsaved Drafts…', onclick: () => host.recoverDrafts!() }),
            'Drafts of modified documents are kept until the window closes cleanly',
          )
        : null,
    ),
    k.group(
      'Language',
      k.row(
        'Language',
        k.select('language', [['auto', 'System Language'], ['en', 'English']], s.language, (v) => k.set({ language: v })),
        '(applied after restart)',
      ),
    ),
    k.group('Shortcut Keys', ...shortcutKeys(k)),
    k.group('Dialogs', h('div.pref-actions', null, resetWarnings, clearRecent)),
    k.group('Advanced Settings', h('div.pref-actions', null, openAdvanced, reset), json, h('div.pref-actions', null, apply, status)),
  );
  return pane;
}

/** "Custom Shortcut Keys": Margin edits them in place ({ "<command name or id>": "Mod+Shift+K" }). */
function shortcutKeys(k: PrefKit): HTMLElement[] {
  const keys = h('textarea.css-input', { rows: '3', spellcheck: 'false', placeholder: '{ "Toggle Sidebar": "Mod+Shift+B" }', 'data-pref': 'keyBinding' });
  const cur = k.cur().keyBinding;
  keys.value = Object.keys(cur).length ? JSON.stringify(cur, null, 2) : '';
  const status = h('span.pref-hint', { 'data-pref-status': 'keyBinding' });
  keys.addEventListener('change', () => {
    try {
      const v = keys.value.trim() ? (JSON.parse(keys.value) as unknown) : {};
      if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error('expected a JSON object');
      k.set({ keyBinding: v as Record<string, string> });
      status.textContent = 'Saved';
    } catch (e) {
      status.textContent = `Invalid JSON: ${e instanceof Error ? e.message : String(e)}`;
    }
  });
  return [
    h('div.pref-label', { text: 'Custom Shortcut Keys' }),
    k.note('Map a command (its name in the command palette, or its id) to a key, e.g. "Mod+Shift+K"; several keys separated by commas.'),
    keys,
    status,
  ];
}
