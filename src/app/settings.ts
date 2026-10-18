import { DEFAULT_MARKDOWN_OPTIONS, type AppSettings, type ImageRule, type MarkdownOptions } from '../contracts';
import { DEFAULT_EXPORT, migrateExportSettings, type ExportSettings } from './export-settings';

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
  restoreLastFolder: boolean;
  /** Export / print settings (#95). */
  export: ExportSettings;
  /** Pandoc binary (or its folder) for docx/latex/epub export; '' = auto-detect (#81). */
  pandocPath: string;
  // ---- #100 Preferences completeness
  /** General › On Launch. */
  onLaunch: OnLaunch;
  /** Folder opened on launch when `onLaunch === 'customFolder'`. */
  defaultFolder: string;
  /** Quit the app when the last window closes (desktop; applied after restart). */
  quitOnLastWindowClose: boolean;
  /** UI language ('auto' = based on current OS). Only English strings ship today. */
  language: string;
  /** Files › Default Line Ending for new files. */
  defaultLineEnding: 'auto' | 'lf' | 'crlf';
  /** Remap Unicode punctuation on parse (#102; persisted, see PR notes). */
  remapPunctuation: boolean;
  /** Appearance › Window Style (desktop, applied after restart). */
  windowStyle: 'seamless' | 'unibody' | 'native';
  /** Appearance › Text Column Width in px; 0 = theme default. */
  textColumnWidth: number;
  showOutlineByDefault: boolean;
  collapsibleOutline: boolean;
  /** Advanced › custom shortcut keys: command id → accelerator (e.g. "Mod+Shift+K"). */
  keyBinding: Record<string, string>;
  /** Markdown / Editor options forwarded to the editing core (#102). */
  markdown: MarkdownOptions;
}

export type OnLaunch = 'newFile' | 'restoreAll' | 'restoreFolders' | 'customFolder';
export const ON_LAUNCH: readonly OnLaunch[] = ['restoreAll', 'restoreFolders', 'newFile', 'customFolder'];

export const SETTINGS_VERSION = 3;

/**
 * Typora's fresh-install Markdown / Editor defaults (typora-re fe-preferences §2, §5, §7):
 * inline math / sub / sup / highlight off, strict mode on, display-source-on-focus off,
 * no automatic equation numbering. Emoji shortcodes are always on in Typora.
 * Installs that predate #102 keep `DEFAULT_MARKDOWN_OPTIONS` (what Margin rendered before).
 */
export const TYPORA_MARKDOWN_DEFAULTS: Readonly<MarkdownOptions> = Object.freeze({
  ...DEFAULT_MARKDOWN_OPTIONS,
  highlight: false,
  inlineMath: false,
  subscript: false,
  superscript: false,
  emoji: true,
  strict: true,
  expandSimpleBlock: false,
  mathNumbering: 'none',
});

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
  restoreLastFolder: false,
  export: DEFAULT_EXPORT,
  pandocPath: '',
  onLaunch: 'newFile',
  defaultFolder: '',
  quitOnLastWindowClose: false,
  language: 'auto',
  defaultLineEnding: 'auto',
  remapPunctuation: false,
  windowStyle: 'seamless',
  textColumnWidth: 0,
  showOutlineByDefault: false,
  collapsibleOutline: false,
  keyBinding: {},
  markdown: { ...TYPORA_MARKDOWN_DEFAULTS },
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

  // v2 "restoreLastFolder" boolean → onLaunch (#100).
  if (raw.onLaunch === undefined && raw.restoreLastFolder === true) raw.onLaunch = 'restoreFolders';
  const onLaunch = (ON_LAUNCH as unknown[]).includes(raw.onLaunch) ? (raw.onLaunch as OnLaunch) : d.onLaunch;
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
    restoreLastFolder: onLaunch === 'restoreAll' || onLaunch === 'restoreFolders',
    export: migrateExportSettings(raw.export),
    pandocPath: typeof raw.pandocPath === 'string' ? raw.pandocPath.trim() : '',
    onLaunch,
    defaultFolder: typeof raw.defaultFolder === 'string' ? raw.defaultFolder.trim() : '',
    quitOnLastWindowClose: bool(raw.quitOnLastWindowClose, d.quitOnLastWindowClose),
    language: str(raw.language, d.language),
    defaultLineEnding: oneOf(raw.defaultLineEnding, ['auto', 'lf', 'crlf'] as const, d.defaultLineEnding),
    remapPunctuation: bool(raw.remapPunctuation, d.remapPunctuation),
    windowStyle: oneOf(raw.windowStyle, ['seamless', 'unibody', 'native'] as const, d.windowStyle),
    textColumnWidth: columnWidth(raw.textColumnWidth),
    showOutlineByDefault: bool(raw.showOutlineByDefault, d.showOutlineByDefault),
    collapsibleOutline: bool(raw.collapsibleOutline, d.collapsibleOutline),
    keyBinding: keyBinding(raw.keyBinding),
    // An existing (pre-#102) install has a settingsVersion but no markdown block: keep its rendering.
    markdown: migrateMarkdown(raw.markdown, raw.markdown === undefined && typeof input === 'object' && input !== null && 'settingsVersion' in input ? DEFAULT_MARKDOWN_OPTIONS : TYPORA_MARKDOWN_DEFAULTS),
  };
}

/**
 * General › On Launch (#100): what to open at startup. Restored / custom targets win;
 * `opts` (the web demo folder and file) is the fallback when nothing is restored.
 */
export function launchPlan(
  s: Pick<MarginSettings, 'onLaunch' | 'defaultFolder' | 'lastFolder' | 'recentFiles'>,
  opts: { initialFolder?: string | null; initialFile?: string | null } = {},
): { folder: string | null; file: string | null } {
  const pref =
    s.onLaunch === 'customFolder' ? s.defaultFolder || null : s.onLaunch === 'restoreAll' || s.onLaunch === 'restoreFolders' ? s.lastFolder : null;
  const lastFile = s.onLaunch === 'restoreAll' ? (s.recentFiles[0] ?? null) : null;
  return { folder: pref || opts.initialFolder || null, file: lastFile ?? opts.initialFile ?? null };
}

/** 0 (theme default) or 400–3000 px. */
function columnWidth(v: unknown): number {
  const n = Math.round(num(v, 0, 0, 3000));
  return n < 400 ? 0 : n;
}

function oneOf<T extends string>(v: unknown, opts: readonly T[], d: T): T {
  return (opts as readonly unknown[]).includes(v) ? (v as T) : d;
}

function keyBinding(v: unknown): Record<string, string> {
  if (!isObj(v)) return {};
  const out: Record<string, string> = {};
  for (const [k, x] of Object.entries(v)) if (typeof x === 'string' && k) out[k] = x.trim();
  return out;
}

/** Validate the nested Markdown options; unknown / malformed fields fall back to defaults. */
export function migrateMarkdown(v: unknown, d: Readonly<MarkdownOptions> = TYPORA_MARKDOWN_DEFAULTS): MarkdownOptions {
  const raw: Raw = isObj(v) ? v : {};
  const out = { ...d } as MarkdownOptions;
  for (const k of Object.keys(d) as (keyof MarkdownOptions)[]) {
    const dv = d[k];
    if (typeof dv === 'boolean') (out as unknown as Raw)[k] = bool(raw[k], dv);
  }
  out.ulStyle = oneOf(raw.ulStyle, ['-', '*', '+'] as const, d.ulStyle);
  out.olStyle = oneOf(raw.olStyle, ['increment', 'ones'] as const, d.olStyle);
  const ci = Number(raw.codeIndentSize);
  out.codeIndentSize = ci === 0 || ci === 2 || ci === 3 || ci === 4 ? ci : d.codeIndentSize;
  out.mathNumbering = oneOf(raw.mathNumbering, ['all', 'ams', 'none'] as const, d.mathNumbering);
  return out;
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

/** Files › Default Line Ending: "Auto ( Recommended )" follows the OS (#100). */
export function newFileEol(pref: MarginSettings['defaultLineEnding'], windows = /Win/i.test(navigator.platform || '')): '\n' | '\r\n' {
  return pref === 'crlf' || (pref === 'auto' && windows) ? '\r\n' : '\n';
}
