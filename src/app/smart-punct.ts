/**
 * Smart punctuation, converted on input (#103, `typora.menu.edit.substitutions`;
 * fe-preferences §10): `"`/`'` become curly quotes (opening after start / space /
 * an opening bracket), `word--` becomes "–" and a further `-` "—", `...` "…".
 * Never right after a backslash; callers skip code, math and link destinations.
 */
export interface SmartOpts {
  quotes: boolean;
  dashes: boolean;
  /** "Convert on Input" mode (`SmartyPantsOnRendering` = false); rendering mode keeps the source ASCII. */
  onInput?: boolean;
}

export interface SmartEdit {
  /** characters before the caret to replace */
  del: number;
  text: string;
}

const OPENERS = /(?:^|[\s([{<“‘«—–\-/])$/u;

export function smartReplace(before: string, ch: string, o: SmartOpts): SmartEdit | null {
  if (before.endsWith('\\')) return null;
  if (o.quotes && (ch === '"' || ch === "'")) {
    const open = OPENERS.test(before);
    if (ch === '"') return { del: 0, text: open ? '“' : '”' };
    return { del: 0, text: open ? '‘' : '’' };
  }
  if (o.dashes && ch === '-') {
    if (before.endsWith('–')) return { del: 1, text: '—' };
    if (/[\p{L}\p{N}]-$/u.test(before)) return { del: 1, text: '–' };
  }
  if (o.dashes && ch === '.' && before.endsWith('..') && !before.endsWith('...')) return { del: 2, text: '…' };
  return null;
}
