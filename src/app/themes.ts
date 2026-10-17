import { BUILTIN_THEMES } from '../themes';

/** Does this theme declare itself dark? (`color-scheme: dark` in its CSS.) */
export function isDarkThemeCss(css: string): boolean {
  return /color-scheme\s*:\s*dark\b/i.test(css.replace(/\/\*[\s\S]*?\*\//g, ''));
}

/**
 * Pick the theme to show.
 *  - 'light': the chosen theme as-is.
 *  - 'dark':  the chosen theme if it is dark, else `darkTheme`.
 *  - 'system': like 'dark' when the OS is dark, else like 'light' — but a dark chosen
 *    theme in a light OS falls back to the first light built-in.
 */
export function effectiveTheme(
  opts: { theme: string; darkTheme: string; colorScheme: 'light' | 'dark' | 'system' },
  osDark: boolean,
  themes: Record<string, string>,
): string {
  const exists = (n: string): boolean => n in themes;
  const theme = exists(opts.theme) ? opts.theme : 'paper';
  const dark = exists(opts.darkTheme) && isDarkThemeCss(themes[opts.darkTheme]) ? opts.darkTheme : 'night';
  const wantDark = opts.colorScheme === 'dark' || (opts.colorScheme === 'system' && osDark);
  const themeIsDark = isDarkThemeCss(themes[theme] ?? '');
  if (wantDark) return themeIsDark ? theme : dark;
  if (opts.colorScheme === 'system' && themeIsDark) {
    if (exists('paper') && !isDarkThemeCss(themes.paper)) return 'paper';
    return Object.keys(themes).find((n) => !isDarkThemeCss(themes[n])) ?? theme;
  }
  return theme;
}

/** Applies theme + custom CSS + font size to the document via <style> elements. */
export class ThemeManager {
  themes: Record<string, string> = { ...BUILTIN_THEMES };
  private themeEl: HTMLStyleElement;
  private customEl: HTMLStyleElement;
  private mq = typeof matchMedia === 'function' ? matchMedia('(prefers-color-scheme: dark)') : null;
  current = '';

  constructor(private onOsChange: () => void) {
    this.themeEl = this.style('margin-theme');
    this.customEl = this.style('margin-custom-css');
    this.mq?.addEventListener?.('change', () => this.onOsChange());
  }

  private style(id: string): HTMLStyleElement {
    let el = document.getElementById(id) as HTMLStyleElement | null;
    if (!el) {
      el = document.createElement('style');
      el.id = id;
      document.head.appendChild(el);
    }
    return el;
  }

  get osDark(): boolean {
    return !!this.mq?.matches;
  }

  /** Merge platform themes (user themes); built-ins keep their names. */
  setExtraThemes(extra: Record<string, string>): void {
    const clean: Record<string, string> = {};
    for (const [k, v] of Object.entries(extra)) clean[k.replace(/\.css$/i, '')] = v;
    this.themes = { ...clean, ...BUILTIN_THEMES };
  }

  names(): string[] {
    const builtins = Object.keys(BUILTIN_THEMES);
    return [...builtins, ...Object.keys(this.themes).filter((n) => !builtins.includes(n)).sort()];
  }

  isDark(name: string): boolean {
    return isDarkThemeCss(this.themes[name] ?? '');
  }

  apply(opts: { theme: string; darkTheme: string; colorScheme: 'light' | 'dark' | 'system'; customCss: string; fontSize: number }): {
    name: string;
    dark: boolean;
  } {
    const name = effectiveTheme(opts, this.osDark, this.themes);
    if (name !== this.current) {
      this.themeEl.textContent = this.themes[name] ?? '';
      this.current = name;
    }
    if (this.customEl.textContent !== opts.customCss) this.customEl.textContent = opts.customCss;
    const root = document.documentElement;
    root.style.setProperty('--margin-font-size', `${opts.fontSize}px`);
    const dark = this.isDark(name);
    root.dataset.theme = name;
    root.dataset.scheme = dark ? 'dark' : 'light';
    return { name, dark };
  }

  /** CSS for exports: current theme + custom CSS. */
  exportCss(): string {
    return `${this.themes[this.current] ?? ''}\n${this.customEl.textContent ?? ''}`;
  }
}
