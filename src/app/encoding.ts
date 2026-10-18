/**
 * Text encodings for opening files (#94: File › Reopen with Encoding, auto-detection).
 * Margin always saves UTF-8 (like Typora); these only affect how bytes are read.
 */

export interface EncodingChoice {
  /** WHATWG encoding label understood by TextDecoder, or 'auto'. */
  id: string;
  label: string;
}

export const ENCODINGS: EncodingChoice[] = [
  { id: 'auto', label: '(Auto Detect)' },
  { id: 'utf-8', label: 'Unicode (UTF-8)' },
  { id: 'utf-16le', label: 'Unicode (UTF-16 LE)' },
  { id: 'utf-16be', label: 'Unicode (UTF-16 BE)' },
  { id: 'gb18030', label: 'Chinese Simplified (GB18030 / GBK)' },
  { id: 'big5', label: 'Chinese Traditional (Big5)' },
  { id: 'shift_jis', label: 'Japanese (Shift JIS)' },
  { id: 'euc-jp', label: 'Japanese (EUC-JP)' },
  { id: 'euc-kr', label: 'Korean (EUC-KR)' },
  { id: 'windows-1252', label: 'Western (Windows Latin 1)' },
  { id: 'iso-8859-2', label: 'Central European (ISO Latin 2)' },
  { id: 'windows-1251', label: 'Cyrillic (Windows)' },
  { id: 'koi8-r', label: 'Cyrillic (KOI8-R)' },
];

export function encodingLabel(id: string): string {
  return ENCODINGS.find((e) => e.id === id)?.label ?? id.toUpperCase();
}

function tryDecode(bytes: Uint8Array, enc: string, fatal: boolean): string | null {
  try {
    return new TextDecoder(enc, { fatal, ignoreBOM: false }).decode(bytes);
  } catch {
    return null;
  }
}

/** Decode with an explicit encoding (BOMs of the matching Unicode encoding are dropped). */
export function decodeBytes(bytes: Uint8Array, enc: string): string {
  if (enc === 'auto') return decodeBytes(bytes, detectEncoding(bytes));
  return tryDecode(bytes, enc, false) ?? new TextDecoder('utf-8').decode(bytes);
}

const isKana = (c: number) => c >= 0x3040 && c <= 0x30ff;
const isHangul = (c: number) => c >= 0xac00 && c <= 0xd7af;
const isHan = (c: number) => c >= 0x4e00 && c <= 0x9fff;

/** How plausible a decoded text is: share of characters a human text would use. */
function plausibility(text: string): { score: number; kana: number; hangul: number; nonAscii: number } {
  let good = 0;
  let kana = 0;
  let hangul = 0;
  let nonAscii = 0;
  for (const ch of text) {
    const c = ch.codePointAt(0)!;
    if (c < 0x80) {
      if (c >= 0x20 || c === 9 || c === 10 || c === 13) good++;
      continue;
    }
    nonAscii++;
    if (c >= 0xff61 && c <= 0xff9f) continue; // half-width katakana: almost always a misread
    if (isKana(c)) (kana++, good++);
    else if (isHangul(c)) (hangul++, good++);
    else if (isHan(c) || (c >= 0x3000 && c <= 0x303f) || (c >= 0xff00 && c <= 0xffef)) good++;
    else if (c >= 0xa0 && c <= 0x24f) good++; // Latin-1 / Latin Extended
    else if (c >= 0x400 && c <= 0x4ff) good += 0.8; // Cyrillic
    else if (c >= 0x2010 && c <= 0x206f) good++; // punctuation
  }
  const n = [...text].length || 1;
  return { score: good / n, kana, hangul, nonAscii };
}

/**
 * Best guess for a file's encoding: BOM → valid UTF-8 → the legacy encoding whose
 * strict decoding looks most like text (CJK first, Latin-1 last).
 */
export function detectEncoding(bytes: Uint8Array): string {
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) return 'utf-8';
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return 'utf-16le';
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return 'utf-16be';
  if (tryDecode(bytes, 'utf-8', true) !== null) return 'utf-8';
  let best = 'windows-1252';
  let bestScore = -1;
  for (const enc of ['gb18030', 'shift_jis', 'euc-kr', 'big5', 'euc-jp']) {
    const text = tryDecode(bytes, enc, true);
    if (text === null) continue;
    const p = plausibility(text);
    let score = p.score;
    // Real Japanese is kana-heavy and real Korean mostly Hangul; Han characters show up in any CJK misread.
    if (p.nonAscii && p.kana / p.nonAscii >= 0.15) score += 0.5;
    if (p.nonAscii && p.hangul / p.nonAscii >= 0.6) score += 0.5;
    if (score > bestScore + 1e-9) {
      best = enc;
      bestScore = score;
    }
  }
  // Western text: accented letters sit between ASCII letters; misread CJK comes in runs.
  if (bestScore < 0.9 || latinLike(bytes) > 0.8) return 'windows-1252';
  return best;
}

/** Share of high bytes that touch an ASCII letter (≈1 for Western text, low for CJK). */
function latinLike(bytes: Uint8Array): number {
  const letter = (b: number | undefined) => b !== undefined && ((b >= 0x41 && b <= 0x5a) || (b >= 0x61 && b <= 0x7a));
  let high = 0;
  let touching = 0;
  for (let i = 0; i < bytes.length; i++) {
    if (bytes[i] < 0x80) continue;
    high++;
    if (letter(bytes[i - 1]) || letter(bytes[i + 1])) touching++;
  }
  return high ? touching / high : 0;
}
