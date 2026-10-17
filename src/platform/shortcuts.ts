import type { MenuAction } from '../contracts';

/**
 * Keyboard shortcuts of the native menu (`src-tauri/src/menu.rs`), as data.
 * - Desktop: the native menu owns these keys; the webview never sees the keydown.
 * - Web (`web.ts`): a capture-phase keydown listener maps them to `onMenu` actions
 *   and stops propagation, mirroring the desktop behaviour.
 * The app may also use this table to display shortcuts.
 */
export interface Shortcut {
  action: MenuAction;
  /** KeyboardEvent.code */
  code: string;
  shift?: boolean;
  alt?: boolean;
  /** false = no Cmd/Ctrl (function keys) */
  mod?: boolean;
}

const m = (action: MenuAction, code: string, extra: Partial<Shortcut> = {}): Shortcut => ({ action, code, mod: true, ...extra });

export const SHORTCUTS: Shortcut[] = [
  m('new', 'KeyN'),
  m('open', 'KeyO'),
  m('openFolder', 'KeyO', { shift: true }),
  m('quickOpen', 'KeyP'),
  m('save', 'KeyS'),
  m('saveAs', 'KeyS', { shift: true }),
  m('close', 'KeyW'),
  m('exportPdf', 'KeyE', { alt: true }),
  m('print', 'KeyP', { shift: true }),
  m('undo', 'KeyZ'),
  m('redo', 'KeyZ', { shift: true }),
  m('find', 'KeyF'),
  m('replace', 'KeyF', { alt: true }),
  m('heading:1', 'Digit1'),
  m('heading:2', 'Digit2'),
  m('heading:3', 'Digit3'),
  m('heading:4', 'Digit4'),
  m('heading:5', 'Digit5'),
  m('heading:6', 'Digit6'),
  m('heading:0', 'Digit0'),
  m('block:table', 'KeyT', { alt: true }),
  m('block:code', 'KeyC', { alt: true }),
  m('block:math', 'KeyB', { alt: true }),
  m('block:quote', 'KeyQ', { alt: true }),
  m('block:ol', 'KeyO', { alt: true }),
  m('block:ul', 'KeyU', { alt: true }),
  m('block:task', 'KeyX', { alt: true }),
  m('block:hr', 'Minus', { alt: true }),
  m('mark:strong', 'KeyB'),
  m('mark:em', 'KeyI'),
  m('mark:code', 'KeyE'),
  m('mark:strike', 'KeyX', { shift: true }),
  m('mark:highlight', 'KeyH', { shift: true }),
  m('mark:link', 'KeyK'),
  m('toggleSidebar', 'Backslash'),
  m('toggleSource', 'Slash'),
  { action: 'toggleFocus', code: 'F8', mod: false },
  { action: 'toggleTypewriter', code: 'F9', mod: false },
  m('zoomReset', 'Digit0', { shift: true }),
  m('zoomIn', 'Equal'),
  m('zoomOut', 'Minus'),
  m('preferences', 'Comma'),
];

/** Match a keydown against the table. Cmd on macOS, Ctrl elsewhere (either accepted). */
export function matchShortcut(e: Pick<KeyboardEvent, 'code' | 'metaKey' | 'ctrlKey' | 'shiftKey' | 'altKey'>): MenuAction | null {
  const mod = e.metaKey || e.ctrlKey;
  for (const s of SHORTCUTS) {
    if (s.code !== e.code) continue;
    if ((s.mod ?? true) !== mod) continue;
    if (!!s.shift !== e.shiftKey || !!s.alt !== e.altKey) continue;
    return s.action;
  }
  return null;
}

/** Human-readable label, e.g. "⌘⇧S" / "Ctrl+Shift+S". */
export function shortcutLabel(action: MenuAction, mac = /Mac|iPhone|iPad/.test(globalThis.navigator?.platform ?? '')): string | null {
  const s = SHORTCUTS.find((x) => x.action === action);
  if (!s) return null;
  const key = s.code.replace(/^Key|^Digit/, '').replace('Backslash', '\\').replace('Slash', '/').replace('Equal', '=').replace('Minus', '-').replace('Comma', ',');
  if (mac) return `${s.alt ? '⌥' : ''}${s.shift ? '⇧' : ''}${s.mod === false ? '' : '⌘'}${key}`;
  return [s.mod === false ? null : 'Ctrl', s.alt ? 'Alt' : null, s.shift ? 'Shift' : null, key].filter(Boolean).join('+');
}
