import type { AppSettings, ImageRule } from '../contracts';

/**
 * App-side settings: the `AppSettings` contract plus shell-only preferences.
 * Extra keys ride along in the same object passed to `platform.saveSettings`
 * (platforms must persist unknown keys verbatim — see ARCHITECTURE.md change log).
 */
export interface MarginSettings extends AppSettings {
  settingsVersion: number;
  /** Theme used when the effective color scheme is dark and `theme` is a light theme. */
  darkTheme: string;
  customCss: string;
  focusMode: boolean;
  typewriterMode: boolean;
  zoom: number;
  sidebarVisible: boolean;
  sidebarTab: 'files' | 'outline';
  sidebarWidth: number;
  /** Auto-save delay in ms after the last edit. */
  autoSaveDelay: number;
  /** @deprecated read by migration only; see `onLaunch`. */
  restoreLastFolder: boolean;
  /** General › On Launch (Typora `restoreWhenLaunch` 0–3). */
  onLaunch: OnLaunch;
  /** Folder for `onLaunch: 'customFolder'` (Typora `pinFolder`). */
  pinFolder: string | null;
  /** Files open in the main window at its last clean close, for `restoreFilesAndFolders`. */
  lastOpenFiles: string[];
  /** Pandoc binary (or its folder) for docx/latex/epub export; '' = auto-detect (#81). */
  pandocPath: string;
  /** Save a modified file without asking when switching documents from the sidebar (#94). */
  saveOnSwitch: boolean;
  /** Documents larger than this (bytes) open in source mode with a warning (#94). */
  largeFileBytes: number;
}

export type OnLaunch = 'newFile' | 'restoreFolders' | 'restoreFilesAndFolders' | 'customFolder';
export const ON_LAUNCH: [OnLaunch, string][] = [
  ['newFile', 'Open new file'],
  ['restoreFolders', 'Restore last closed folders'],
  ['restoreFilesAndFolders', 'Restore last closed files and folders'],
  ['customFolder', 'Open custom folder'],
];

export const SETTINGS_VERSION = 2;

export const DEFAULT_SETTINGS: Readonly<MarginSettings> = Object.freeze({
  settingsVersion: SETTINGS_VERSION,
  theme: 'paper',
  darkTheme: 'night',
  colorScheme: 'system',
  fontSize: 16,
  autoSave: false,
  autoSaveDelay: 1500,
  imageRule: { kind: 'relative', dir: './assets' } as ImageRule,
  spellcheck: false,
  recentFiles: [],
  recentFolders: [],
  lastFolder: null,
  customCss: '',
  focusMode: false,
  typewriterMode: false,
  zoom: 1,
  sidebarVisible: true,
  sidebarTab: 'files',
  sidebarWidth: 260,
  restoreLastFolder: true,
  onLaunch: 'restoreFolders' as OnLaunch,
  pinFolder: null,
  lastOpenFiles: [],
  pandocPath: '',
  saveOnSwitch: false,
  largeFileBytes: 2_000_000,
});

export const MAX_RECENT = 15;

type Raw = Record<string, unknown>;

const isObj = (v: unknown): v is Raw => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown, d: string): string => (typeof v === 'string' && v.trim() ? v : d);
const bool = (v: unknown, d: boolean): boolean =>
  typeof v === 'boolean' ? v : v === 'true' ? true : v === 'false' ? false : d;
const num = (v: unknown, d: number, min: number, max: number): number => {
  const n = typeof v === 'string' ? parseFloat(v) : v;
  return typeof n === 'number' && Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : d;
};
const strList = (v: unknown): string[] => {
  if (!Array.isArray(v)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const x of v) {
    if (typeof x !== 'string' || !x || seen.has(x)) continue;
    seen.add(x);
    out.push(x);
  }
  return out.slice(0, MAX_RECENT);
};

/** Accepts current object form and legacy string forms ("./assets", "none", "/abs/dir"). */
export function migrateImageRule(v: unknown): ImageRule {
  if (typeof v === 'string') {
    const s = v.trim();
    if (!s || s === 'none') return { kind: 'none' };
    if (s.startsWith('/') || /^[a-zA-Z]:[\\/]/.test(s)) return { kind: 'absolute', dir: s };
    return { kind: 'relative', dir: s.startsWith('.') ? s : './' + s };
  }
  if (isObj(v)) {
    if (v.kind === 'none') return { kind: 'none' };
    if ((v.kind === 'relative' || v.kind === 'absolute') && typeof v.dir === 'string' && v.dir.trim())
      return { kind: v.kind, dir: v.dir.trim() };
  }
  return { ...(DEFAULT_SETTINGS.imageRule as ImageRule) };
}

/** Validate + fill defaults for whatever the platform returned. Never throws. */
export function migrateSettings(input: unknown): MarginSettings {
  const raw: Raw = isObj(input) ? { ...input } : {};
  const d = DEFAULT_SETTINGS;

  // v1 → v2 renames: "darkMode" boolean, "sidebar" boolean, "autosave".
  if (raw.colorScheme === undefined && typeof raw.darkMode === 'boolean') raw.colorScheme = raw.darkMode ? 'dark' : 'light';
  if (raw.sidebarVisible === undefined && typeof raw.sidebar === 'boolean') raw.sidebarVisible = raw.sidebar;
  if (raw.autoSave === undefined && raw.autosave !== undefined) raw.autoSave = raw.autosave;
  if (raw.imageRule === undefined && raw.imageFolder !== undefined) raw.imageRule = raw.imageFolder;

  const scheme = raw.colorScheme;
  const tab = raw.sidebarTab;
  return {
    ...raw,
    settingsVersion: SETTINGS_VERSION,
    theme: str(raw.theme, d.theme).replace(/\.css$/i, ''),
    darkTheme: str(raw.darkTheme, d.darkTheme).replace(/\.css$/i, ''),
    colorScheme: scheme === 'light' || scheme === 'dark' || scheme === 'system' ? scheme : d.colorScheme,
    fontSize: Math.round(num(raw.fontSize, d.fontSize, 10, 32)),
    autoSave: bool(raw.autoSave, d.autoSave),
    autoSaveDelay: num(raw.autoSaveDelay, d.autoSaveDelay, 300, 60_000),
    imageRule: migrateImageRule(raw.imageRule),
    spellcheck: bool(raw.spellcheck, d.spellcheck),
    recentFiles: strList(raw.recentFiles),
    recentFolders: strList(raw.recentFolders),
    lastFolder: typeof raw.lastFolder === 'string' && raw.lastFolder ? raw.lastFolder : null,
    customCss: typeof raw.customCss === 'string' ? raw.customCss : '',
    focusMode: bool(raw.focusMode, d.focusMode),
    typewriterMode: bool(raw.typewriterMode, d.typewriterMode),
    zoom: num(raw.zoom, d.zoom, 0.5, 3),
    sidebarVisible: bool(raw.sidebarVisible, d.sidebarVisible),
    sidebarTab: tab === 'files' || tab === 'outline' ? tab : d.sidebarTab,
    sidebarWidth: Math.round(num(raw.sidebarWidth, d.sidebarWidth, 180, 520)),
    restoreLastFolder: bool(raw.restoreLastFolder, d.restoreLastFolder),
    onLaunch: ON_LAUNCH.some(([v]) => v === raw.onLaunch)
      ? (raw.onLaunch as OnLaunch)
      : bool(raw.restoreLastFolder, d.restoreLastFolder)
        ? 'restoreFolders'
        : 'newFile',
    pinFolder: typeof raw.pinFolder === 'string' && raw.pinFolder ? raw.pinFolder : null,
    lastOpenFiles: strList(raw.lastOpenFiles),
    pandocPath: typeof raw.pandocPath === 'string' ? raw.pandocPath.trim() : '',
    saveOnSwitch: bool(raw.saveOnSwitch, d.saveOnSwitch),
    largeFileBytes: Math.round(num(raw.largeFileBytes, d.largeFileBytes, 1_000, 1_000_000_000)),
  };
}

/** Move `item` to the front of a recent list (dedup, capped). */
export function pushRecent(list: readonly string[], item: string, max = MAX_RECENT): string[] {
  return [item, ...list.filter((x) => x !== item)].slice(0, max);
}

/** Preset image rules shown in Preferences. */
export const IMAGE_RULE_PRESETS: { id: string; label: string; rule: ImageRule }[] = [
  { id: 'assets', label: 'Copy to ./assets', rule: { kind: 'relative', dir: './assets' } },
  { id: 'filename', label: 'Copy to ./${filename}.assets', rule: { kind: 'relative', dir: './${filename}.assets' } },
  { id: 'absolute', label: 'Copy to folder…', rule: { kind: 'absolute', dir: '' } },
  { id: 'none', label: 'Keep original location', rule: { kind: 'none' } },
];

export function imageRulePresetId(rule: ImageRule): string {
  if (rule.kind === 'none') return 'none';
  if (rule.kind === 'absolute') return 'absolute';
  if (rule.dir === './${filename}.assets') return 'filename';
  if (rule.dir === './assets') return 'assets';
  return 'custom';
}
