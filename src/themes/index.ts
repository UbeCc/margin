import paper from './paper.css?raw';
import github from './github.css?raw';
import night from './night.css?raw';

/** Built-in theme CSS keyed by theme name. */
export const BUILTIN_THEMES: Readonly<Record<string, string>> = Object.freeze({ paper, github, night });

export const THEME_LABELS: Readonly<Record<string, string>> = Object.freeze({
  paper: 'Paper',
  github: 'GitHub',
  night: 'Night',
});

export function themeLabel(name: string): string {
  return THEME_LABELS[name] ?? name.replace(/[-_]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}
