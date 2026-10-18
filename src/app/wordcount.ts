/**
 * Word count rules (fe-sidebar-statusbar-find §8, editor-core §8.3) for the status
 * bar and its popover (#103, `typora.menu.view.status-bar`).
 *
 * - Every CJK character (kana, CJK ideographs, compatibility forms — not Hangul)
 *   counts as one word.
 * - The rest is split on whitespace, CJK punctuation and ASCII punctuation except
 *   `-` `.` `/` `'`; punctuation-only tokens are dropped ("don't", "a-b", "3.14" = 1).
 * - Characters = length of the raw Markdown; Lines = newlines + 1.
 * - Reading time = round(words / wpm); 0 shows as "≤ 1".
 */

const CJK = /[⺀-⿟々-〇〡-〩〸-〼぀-ヿ㆐-㆟㇀-ㇿ㈀-㋿㌀-㏿㐀-䶿一-鿿豈-﫿︰-﹏ｦ-ﾟ]|[\u{20000}-\u{2FA1F}]/u;
const CJK_G = new RegExp(CJK.source, 'gu');
/** Separators: whitespace, CJK/fullwidth punctuation, ASCII punctuation except - . / ' */
const SEP = /[\s　-〄〈-〠〰〽！-／：-＠［-｀｛-･‐-‧‰-⁞!"#$%&()*+,:;<=>?@[\\\]^_`{|}~]+/u;
const WORDY = /[\p{L}\p{N}]/u;

export function countWords(text: string): number {
  let n = 0;
  const rest = text.replace(CJK_G, () => {
    n++;
    return ' ';
  });
  for (const tok of rest.split(SEP)) if (tok && WORDY.test(tok)) n++;
  return n;
}

/**
 * Text that is counted for a Markdown source: link / image destinations and HTML
 * tag names are not prose, everything else (code, math, front matter) is.
 */
export function countableText(md: string): string {
  return md
    .replace(/(!?\[[^\]\n]*\])\((?:[^()\s]|\([^()\s]*\))*(?:\s+(?:"[^"]*"|'[^']*'))?\)/g, '$1')
    .replace(/<\/?[A-Za-z][^>\n]*>/g, ' ');
}

export interface Counts {
  words: number;
  characters: number;
  lines: number;
}

export function countMarkdown(md: string): Counts {
  return { words: countWords(countableText(md)), characters: md.length, lines: md.split('\n').length };
}

export type CountUnit = 'words' | 'characters' | 'lines' | 'minutes';

/** Typora `wordCountDelimiter` codes: 0 words, 1 characters, 2 lines, 3 minutes. */
export const UNIT_CODES: CountUnit[] = ['words', 'characters', 'lines', 'minutes'];

export const DEFAULT_WPM = 382;
export const WPM_PRESETS = [120, 240, 382];

export function readingMinutes(words: number, wpm = DEFAULT_WPM): number {
  return Math.round(words / Math.max(1, wpm));
}

const LABELS: Record<CountUnit, [string, string]> = {
  words: ['Word', 'Words'],
  characters: ['Character', 'Characters'],
  lines: ['Line', 'Lines'],
  minutes: ['Minute', 'Minutes'],
};

/** "1 Word" / "12 Words"; minutes: 0 → "≤ 1 Minute". */
export function formatCount(n: number, unit: CountUnit): string {
  if (unit === 'minutes' && n === 0) return `≤ 1 ${LABELS.minutes[0]}`;
  return `${n.toLocaleString('en-US')} ${LABELS[unit][n === 1 ? 0 : 1]}`;
}

export function unitLabel(n: number, unit: CountUnit): string {
  return LABELS[unit][n === 1 ? 0 : 1];
}
