/**
 * Shortcut strings: "Mod+Shift+P", "Mod+Alt+F", "F8", "Mod+\\".
 * `Mod` = Cmd on macOS, Ctrl elsewhere. Matching uses KeyboardEvent.code so it is
 * layout/modifier independent (Shift+1 still matches "Digit1").
 */

export const isMac =
  typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);

export interface ParsedShortcut {
  mod: boolean;
  ctrl: boolean;
  shift: boolean;
  alt: boolean;
  code: string;
}

const KEY_TO_CODE: Record<string, string> = {
  '\\': 'Backslash',
  '/': 'Slash',
  '=': 'Equal',
  '+': 'Equal',
  '-': 'Minus',
  ',': 'Comma',
  '.': 'Period',
  '`': 'Backquote',
  ';': 'Semicolon',
  "'": 'Quote',
  '[': 'BracketLeft',
  ']': 'BracketRight',
  Enter: 'Enter',
  Escape: 'Escape',
  Esc: 'Escape',
  Tab: 'Tab',
  Space: 'Space',
  Backspace: 'Backspace',
  Delete: 'Delete',
  Up: 'ArrowUp',
  Down: 'ArrowDown',
  Left: 'ArrowLeft',
  Right: 'ArrowRight',
};

export function keyToCode(key: string): string {
  if (KEY_TO_CODE[key]) return KEY_TO_CODE[key];
  if (/^[a-z]$/i.test(key)) return 'Key' + key.toUpperCase();
  if (/^[0-9]$/.test(key)) return 'Digit' + key;
  if (/^F\d{1,2}$/i.test(key)) return key.toUpperCase();
  return key;
}

export function parseShortcut(s: string): ParsedShortcut {
  // Split on '+' but allow a trailing '+' key ("Mod++").
  const parts = s.endsWith('++') ? [...s.slice(0, -2).split('+'), '+'] : s.split('+');
  const p: ParsedShortcut = { mod: false, ctrl: false, shift: false, alt: false, code: '' };
  for (const part of parts) {
    const k = part.trim();
    const lk = k.toLowerCase();
    if (lk === 'mod' || lk === 'cmdorctrl') p.mod = true;
    else if (lk === 'ctrl' || lk === 'control') p.ctrl = true;
    else if (lk === 'shift') p.shift = true;
    else if (lk === 'alt' || lk === 'option') p.alt = true;
    else if (lk === 'cmd' || lk === 'meta') p.mod = true;
    else p.code = keyToCode(k);
  }
  return p;
}

export interface KeyLike {
  code: string;
  key?: string;
  metaKey: boolean;
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
}

export function matchShortcut(e: KeyLike, s: ParsedShortcut | string, mac = isMac): boolean {
  const p = typeof s === 'string' ? parseShortcut(s) : s;
  const wantMeta = mac ? p.mod : false;
  const wantCtrl = mac ? p.ctrl : p.mod || p.ctrl;
  if (e.metaKey !== wantMeta || e.ctrlKey !== wantCtrl || e.altKey !== p.alt || e.shiftKey !== p.shift) return false;
  let code = e.code;
  if (code === 'NumpadAdd') code = 'Equal';
  if (code === 'NumpadSubtract') code = 'Minus';
  if (/^Numpad\d$/.test(code)) code = 'Digit' + code.slice(6);
  return code === p.code;
}

const CODE_LABEL: Record<string, string> = {
  Backslash: '\\',
  Slash: '/',
  Equal: '=',
  Minus: '-',
  Comma: ',',
  Period: '.',
  Backquote: '`',
  Semicolon: ';',
  Quote: "'",
  BracketLeft: '[',
  BracketRight: ']',
  Enter: '↩',
  Escape: 'Esc',
  ArrowUp: '↑',
  ArrowDown: '↓',
  ArrowLeft: '←',
  ArrowRight: '→',
};

export function formatShortcut(s: string, mac = isMac): string {
  const p = parseShortcut(s);
  const key = CODE_LABEL[p.code] ?? p.code.replace(/^Key|^Digit/, '');
  if (mac) return `${p.ctrl ? '⌃' : ''}${p.alt ? '⌥' : ''}${p.shift ? '⇧' : ''}${p.mod ? '⌘' : ''}${key}`;
  return [p.mod || p.ctrl ? 'Ctrl' : '', p.alt ? 'Alt' : '', p.shift ? 'Shift' : '', key].filter(Boolean).join('+');
}
