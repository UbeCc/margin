import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS, imageRulePresetId, launchPlan, migrateImageRule, TYPORA_MARKDOWN_DEFAULTS, migrateSettings, newFileEol, pushRecent, SETTINGS_VERSION } from '../settings';
import { DEFAULT_MARKDOWN_OPTIONS } from '../../contracts';
import { effectiveTheme, isDarkThemeCss } from '../themes';
// Vitest stubs `?raw` CSS imports to '' — read the theme files directly.
// @ts-expect-error node builtin without @types/node
import { readFileSync } from 'node:fs';

const read = (n: string): string => readFileSync(`${(globalThis as unknown as { process: { cwd(): string } }).process.cwd()}/src/themes/${n}.css`, 'utf8') as string;
const BUILTIN_THEMES: Record<string, string> = { paper: read('paper'), github: read('github'), night: read('night') };

describe('settings migration', () => {
  it('fills defaults for garbage input', () => {
    for (const raw of [null, undefined, 42, 'x', []]) {
      const s = migrateSettings(raw);
      expect(s.theme).toBe(DEFAULT_SETTINGS.theme);
      expect(s.settingsVersion).toBe(SETTINGS_VERSION);
      expect(s.recentFiles).toEqual([]);
    }
  });
  it('validates and clamps values', () => {
    const s = migrateSettings({ fontSize: 99, colorScheme: 'blue', zoom: '1.5', theme: 'night.css', sidebarWidth: 10, autoSave: 'true' });
    // #134: Font Size "Customized" clamps to Typora's 9–24 px (Auto = theme default 16).
    expect(s.useCustomFontSize).toBe(true);
    expect(s.customFontSize).toBe(24);
    expect(s.fontSize).toBe(24);
    expect(s.colorScheme).toBe('system');
    expect(s.zoom).toBe(1.5);
    expect(s.theme).toBe('night');
    expect(s.sidebarWidth).toBe(180);
    expect(s.autoSave).toBe(true);
  });
  it('#134: font size Auto keeps the theme default; explicit Customized clamps to 9–24', () => {
    expect(migrateSettings({ useCustomFontSize: false, customFontSize: 30 }).fontSize).toBe(16);
    expect(migrateSettings({ useCustomFontSize: true, customFontSize: 4 }).customFontSize).toBe(9);
    expect(migrateSettings({ useCustomFontSize: true, customFontSize: 30 }).customFontSize).toBe(24);
  });
  it('migrates v1 keys', () => {
    const s = migrateSettings({ darkMode: true, sidebar: false, autosave: true, imageFolder: './img' });
    expect(s.colorScheme).toBe('dark');
    expect(s.sidebarVisible).toBe(false);
    expect(s.autoSave).toBe(true);
    expect(s.imageRule).toEqual({ kind: 'relative', dir: './img' });
  });
  it('dedupes and caps recent lists', () => {
    const many = Array.from({ length: 40 }, (_, i) => `/f${i % 30}.md`);
    const s = migrateSettings({ recentFiles: [...many, 3, null] });
    expect(new Set(s.recentFiles).size).toBe(s.recentFiles.length);
    expect(s.recentFiles.length).toBeLessThanOrEqual(15);
    expect(pushRecent(['/a', '/b', '/c'], '/c')).toEqual(['/c', '/a', '/b']);
  });
  it('keeps unknown keys for forward compatibility', () => {
    expect((migrateSettings({ futureThing: 1 }) as unknown as Record<string, unknown>).futureThing).toBe(1);
  });
  it('image rule forms', () => {
    expect(migrateImageRule('none')).toEqual({ kind: 'none' });
    expect(migrateImageRule('/Users/me/img')).toEqual({ kind: 'absolute', dir: '/Users/me/img' });
    expect(migrateImageRule('assets')).toEqual({ kind: 'relative', dir: './assets' });
    expect(migrateImageRule({ kind: 'absolute', dir: '' })).toEqual(DEFAULT_SETTINGS.imageRule);
    expect(imageRulePresetId({ kind: 'relative', dir: './${filename}.assets' })).toBe('filename');
  });
});

describe('themes', () => {
  it('detects dark themes', () => {
    expect(isDarkThemeCss(BUILTIN_THEMES.night)).toBe(true);
    expect(isDarkThemeCss(BUILTIN_THEMES.paper)).toBe(false);
    expect(isDarkThemeCss('/* color-scheme: dark */ :root{}')).toBe(false);
  });
  it('picks the effective theme for each color scheme', () => {
    const t = BUILTIN_THEMES as Record<string, string>;
    const base = { theme: 'github', darkTheme: 'night' };
    expect(effectiveTheme({ ...base, colorScheme: 'light' }, true, t)).toBe('github');
    expect(effectiveTheme({ ...base, colorScheme: 'dark' }, false, t)).toBe('night');
    expect(effectiveTheme({ ...base, colorScheme: 'system' }, true, t)).toBe('night');
    expect(effectiveTheme({ ...base, colorScheme: 'system' }, false, t)).toBe('github');
    expect(effectiveTheme({ theme: 'missing', darkTheme: 'paper', colorScheme: 'dark' }, false, t)).toBe('night');
    // a dark main theme under a light OS falls back to the default light theme, not whichever comes first
    expect(effectiveTheme({ theme: 'night', darkTheme: 'night', colorScheme: 'system' }, false, { github: t.github, night: t.night, paper: t.paper })).toBe('paper');
  });
  it('built-in themes define the widget variables', () => {
    for (const css of Object.values(BUILTIN_THEMES))
      for (const v of ['--margin-fg', '--margin-bg', '--margin-accent', '--margin-code-bg', '--margin-border', '--margin-font-body', '--margin-font-mono'])
        expect(css).toContain(`${v}:`);
  });
});

describe('preferences completeness (#100, #102)', () => {
  it('defaults: Typora-style On Launch and Markdown options', () => {
    const s = migrateSettings({});
    expect(s.onLaunch).toBe('newFile');
    expect(s.defaultLineEnding).toBe('auto');
    expect(s.markdown).toEqual(TYPORA_MARKDOWN_DEFAULTS);
    expect(s.markdown).toMatchObject({ inlineMath: false, highlight: false, subscript: false, superscript: false, strict: true, emoji: true, expandSimpleBlock: false, mathNumbering: 'none', visibleBr: true, codeLineWrap: true, autoPairBrackets: true, autoPairMarkdown: false });
  });

  it('an install that predates #102 keeps its rendering (no markdown block yet)', () => {
    expect(migrateSettings({ settingsVersion: 2, theme: 'paper' }).markdown).toEqual(DEFAULT_MARKDOWN_OPTIONS);
    expect(migrateSettings({ settingsVersion: 3, markdown: {} }).markdown).toEqual(TYPORA_MARKDOWN_DEFAULTS);
    expect(migrateSettings({}).keyBinding).toEqual({});
  });

  it('migrates restoreLastFolder → onLaunch restoreFolders', () => {
    expect(migrateSettings({ restoreLastFolder: true }).onLaunch).toBe('restoreFolders');
    expect(migrateSettings({ restoreLastFolder: false }).onLaunch).toBe('newFile');
    expect(migrateSettings({ restoreLastFolder: true, onLaunch: 'customFolder' }).onLaunch).toBe('customFolder');
    expect(migrateSettings({ onLaunch: 'bogus' }).onLaunch).toBe('newFile');
  });

  it('validates nested markdown options field by field', () => {
    const m = migrateSettings({ markdown: { emoji: true, ulStyle: '*', olStyle: 'x', codeIndentSize: 7, mathNumbering: 'all', strict: 'nope' } }).markdown;
    expect(m.emoji).toBe(true);
    expect(m.ulStyle).toBe('*');
    expect(m.olStyle).toBe('increment');
    expect(m.codeIndentSize).toBe(4);
    expect(m.mathNumbering).toBe('all');
    expect(m.strict).toBe(true);
  });

  it('#127 math copy format and Shift+Tab auto-indent defaults and validation', () => {
    const d = migrateSettings({}).markdown;
    expect(d.mathCopyFormat).toBe('svg');
    expect(d.shiftTabAutoIndent).toBe(false);
    const m = migrateSettings({ markdown: { mathCopyFormat: 'latex', shiftTabAutoIndent: true } }).markdown;
    expect(m.mathCopyFormat).toBe('latex');
    expect(m.shiftTabAutoIndent).toBe(true);
    const bad = migrateSettings({ markdown: { mathCopyFormat: 'png', shiftTabAutoIndent: 'yes' } }).markdown;
    expect(bad.mathCopyFormat).toBe('svg');
    expect(bad.shiftTabAutoIndent).toBe(false);
    // Typora's key was `mathFormatOnCopy` ('svg'/'latex') — carried over when Margin's is unset.
    expect(migrateSettings({ markdown: { mathFormatOnCopy: 'latex' } }).markdown.mathCopyFormat).toBe('latex');
    expect(migrateSettings({ markdown: { mathFormatOnCopy: 'svg', mathCopyFormat: 'latex' } }).markdown.mathCopyFormat).toBe('latex');
  });

  it('#133: top-level remapPunctuation migrates into markdown; new keys validate', () => {
    expect(migrateSettings({ remapPunctuation: true }).markdown.remapPunctuation).toBe(true);
    // an explicit markdown value wins over the legacy top-level key
    expect(migrateSettings({ remapPunctuation: true, markdown: { remapPunctuation: false } }).markdown.remapPunctuation).toBe(false);
    expect(migrateSettings({ markdown: { smartPunctuation: 'rendering', smartQuote: true, smartDash: true, indentSize: 4, prettyIndent: true, headingStyle: 'setext' } }).markdown).toMatchObject({
      smartPunctuation: 'rendering', smartQuote: true, smartDash: true, indentSize: 4, prettyIndent: true, headingStyle: 'setext',
    });
    const bad = migrateSettings({ markdown: { smartPunctuation: 'both', indentSize: 7, headingStyle: 'wow' } }).markdown;
    expect(bad.smartPunctuation).toBe('input');
    expect(bad.indentSize).toBe(0);
    expect(bad.headingStyle).toBe('atx');
  });

  it('text column width is 0 (theme default) or 400–3000', () => {
    expect(migrateSettings({ textColumnWidth: 120 }).textColumnWidth).toBe(0);
    expect(migrateSettings({ textColumnWidth: 900 }).textColumnWidth).toBe(900);
    expect(migrateSettings({ textColumnWidth: 9000 }).textColumnWidth).toBe(3000);
  });

  it('launchPlan follows On Launch', () => {
    const base = { defaultFolder: '/custom', lastFolder: '/last', recentFiles: ['/last/a.md'] };
    const demo = { initialFolder: '/demo', initialFile: '/demo/Welcome.md' };
    expect(launchPlan({ ...base, onLaunch: 'newFile' }, demo)).toEqual({ folder: '/demo', file: '/demo/Welcome.md' });
    expect(launchPlan({ ...base, onLaunch: 'newFile' })).toEqual({ folder: null, file: null });
    expect(launchPlan({ ...base, onLaunch: 'restoreFolders' })).toEqual({ folder: '/last', file: null });
    expect(launchPlan({ ...base, onLaunch: 'restoreAll' }, demo)).toEqual({ folder: '/last', file: '/last/a.md' });
    expect(launchPlan({ ...base, onLaunch: 'customFolder' })).toEqual({ folder: '/custom', file: null });
    expect(launchPlan({ ...base, defaultFolder: '', onLaunch: 'customFolder' }, demo).folder).toBe('/demo');
  });

  it('newFileEol: Auto follows the OS', () => {
    expect(newFileEol('auto', false)).toBe('\n');
    expect(newFileEol('auto', true)).toBe('\r\n');
    expect(newFileEol('crlf', false)).toBe('\r\n');
    expect(newFileEol('lf', true)).toBe('\n');
  });
});
