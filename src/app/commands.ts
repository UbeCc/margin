import type { MenuAction } from '../contracts';
import { SHORTCUTS, type Shortcut } from '../platform/shortcuts';
import { isMac, matchShortcut, parseShortcut, type KeyLike, type ParsedShortcut } from './util/keymap';

/** Shell-only commands that have no native menu equivalent. */
export type AppCommand =
  | 'commandPalette'
  | 'showFiles'
  | 'showOutline'
  | 'revealActiveFile'
  | 'reloadFromDisk'
  | 'openThemesFolder'
  | 'toggleLineEnding'
  | 'uploadAllImages';

export type CommandId = MenuAction | AppCommand;

export interface CommandSpec {
  id: CommandId;
  label: string;
  category: 'File' | 'Edit' | 'Paragraph' | 'Format' | 'View' | 'Theme' | 'App';
  /** First entry is the displayed shortcut. */
  keys?: string[];
  /**
   * 'editor': only fires when focus is in the document (or nowhere in particular),
   * not while typing in the find bar / palette / dialogs.
   */
  scope?: 'global' | 'editor';
  /** Let the key event reach the editor (shortcut is display-only, e.g. undo). */
  passthrough?: boolean;
}

const H = (n: 0 | 1 | 2 | 3 | 4 | 5 | 6): CommandSpec => ({
  id: `heading:${n}`,
  label: n ? `Heading ${n}` : 'Paragraph',
  category: 'Paragraph',
  keys: [`Mod+${n}`],
  scope: 'editor',
});

export const COMMANDS: CommandSpec[] = [
  { id: 'new', label: 'New File', category: 'File', keys: ['Mod+N'] },
  { id: 'open', label: 'Open…', category: 'File', keys: ['Mod+O'] },
  { id: 'openFolder', label: 'Open Folder…', category: 'File', keys: ['Mod+Shift+O'] },
  { id: 'quickOpen', label: 'Quick Open…', category: 'File', keys: ['Mod+P'] },
  { id: 'save', label: 'Save', category: 'File', keys: ['Mod+S'] },
  { id: 'saveAs', label: 'Save As…', category: 'File', keys: ['Mod+Shift+S'] },
  { id: 'close', label: 'Close File', category: 'File', keys: ['Mod+W'] },
  { id: 'reloadFromDisk', label: 'Reload From Disk', category: 'File' },
  { id: 'exportHtml', label: 'Export as HTML…', category: 'File' },
  { id: 'exportPdf', label: 'Export as PDF…', category: 'File', keys: ['Mod+Alt+E'] },
  { id: 'print', label: 'Print…', category: 'File', keys: ['Mod+Shift+P'] },
  { id: 'preferences', label: 'Preferences…', category: 'App', keys: ['Mod+,'] },
  { id: 'commandPalette', label: 'Command Palette…', category: 'App', keys: ['Mod+Shift+A'] },

  { id: 'undo', label: 'Undo', category: 'Edit', keys: ['Mod+Z'], scope: 'editor', passthrough: true },
  { id: 'redo', label: 'Redo', category: 'Edit', keys: isMac ? ['Mod+Shift+Z'] : ['Mod+Shift+Z', 'Mod+Y'], scope: 'editor', passthrough: true },
  { id: 'find', label: 'Find…', category: 'Edit', keys: ['Mod+F'] },
  { id: 'replace', label: 'Find and Replace…', category: 'Edit', keys: isMac ? ['Mod+Alt+F'] : ['Mod+H', 'Mod+Alt+F'] },

  H(1), H(2), H(3), H(4), H(5), H(6), H(0),
  { id: 'block:quote', label: 'Quote', category: 'Paragraph', keys: ['Mod+Alt+Q'], scope: 'editor' },
  { id: 'block:ol', label: 'Ordered List', category: 'Paragraph', keys: ['Mod+Alt+O'], scope: 'editor' },
  { id: 'block:ul', label: 'Bullet List', category: 'Paragraph', keys: ['Mod+Alt+U'], scope: 'editor' },
  { id: 'block:task', label: 'Task List', category: 'Paragraph', keys: ['Mod+Alt+X'], scope: 'editor' },
  { id: 'block:code', label: 'Code Block', category: 'Paragraph', keys: ['Mod+Alt+C'], scope: 'editor' },
  { id: 'block:math', label: 'Math Block', category: 'Paragraph', keys: ['Mod+Alt+B'], scope: 'editor' },
  { id: 'block:table', label: 'Table', category: 'Paragraph', keys: ['Mod+Alt+T'], scope: 'editor' },
  { id: 'block:hr', label: 'Horizontal Rule', category: 'Paragraph', keys: ['Mod+Alt+-'], scope: 'editor' },
  { id: 'block:toc', label: 'Table of Contents', category: 'Paragraph', scope: 'editor' },

  { id: 'mark:strong', label: 'Bold', category: 'Format', keys: ['Mod+B'], scope: 'editor' },
  { id: 'mark:em', label: 'Italic', category: 'Format', keys: ['Mod+I'], scope: 'editor' },
  { id: 'mark:code', label: 'Inline Code', category: 'Format', keys: ['Mod+E', 'Ctrl+Shift+`'], scope: 'editor' },
  { id: 'mark:strike', label: 'Strikethrough', category: 'Format', keys: ['Mod+Shift+X'], scope: 'editor' },
  { id: 'mark:highlight', label: 'Highlight', category: 'Format', keys: ['Mod+Shift+H'], scope: 'editor' },
  { id: 'mark:link', label: 'Link', category: 'Format', keys: ['Mod+K'], scope: 'editor' },

  { id: 'toggleSidebar', label: 'Toggle Sidebar', category: 'View', keys: ['Mod+\\', 'Mod+Shift+L'] },
  { id: 'showOutline', label: 'Show Outline', category: 'View', keys: ['Mod+Shift+1'] },
  { id: 'showFiles', label: 'Show Files', category: 'View', keys: ['Mod+Shift+3'] },
  { id: 'revealActiveFile', label: 'Reveal Active File in Sidebar', category: 'View' },
  { id: 'toggleSource', label: 'Toggle Source Code Mode', category: 'View', keys: ['Mod+/'] },
  { id: 'toggleFocus', label: 'Focus Mode', category: 'View', keys: ['F8'] },
  { id: 'toggleTypewriter', label: 'Typewriter Mode', category: 'View', keys: ['F9'] },
  { id: 'zoomIn', label: 'Zoom In', category: 'View', keys: ['Mod+=', 'Mod+Shift+='] },
  { id: 'zoomOut', label: 'Zoom Out', category: 'View', keys: ['Mod+-', 'Mod+Shift+-'] },
  { id: 'zoomReset', label: 'Actual Size', category: 'View', keys: ['Mod+Shift+0'] },
  { id: 'toggleLineEnding', label: 'Toggle Line Endings (LF / CRLF)', category: 'View' },
  { id: 'openThemesFolder', label: 'Open Themes Folder', category: 'Theme' },
  { id: 'uploadAllImages', label: 'Upload All Local Images', category: 'Format' },
];

/** 'Mod+Shift+S' form of a native menu accelerator (src/platform/shortcuts.ts). */
export function nativeKey(s: Shortcut): string {
  const key = s.code.replace(/^Key|^Digit/, '').replace('Backslash', '\\').replace('Slash', '/').replace('Equal', '=').replace('Minus', '-').replace('Comma', ',');
  return [s.mod === false ? null : 'Mod', s.alt ? 'Alt' : null, s.shift ? 'Shift' : null, key].filter(Boolean).join('+');
}

// The native menu owns these keys (they arrive via platform.onMenu, never as keydown on
// desktop): make its accelerator the displayed one so labels never drift from the menu.
for (const s of SHORTCUTS) {
  const spec = COMMANDS.find((c) => c.id === s.action);
  if (!spec) continue;
  const k = nativeKey(s);
  spec.keys = [k, ...(spec.keys ?? []).filter((x) => x !== k)];
}

const BY_ID = new Map(COMMANDS.map((c) => [c.id, c]));
export function commandSpec(id: CommandId): CommandSpec | undefined {
  return BY_ID.get(id);
}

const PARSED: { spec: CommandSpec; keys: ParsedShortcut[] }[] = COMMANDS.filter((c) => c.keys?.length).map((spec) => ({
  spec,
  keys: spec.keys!.map(parseShortcut),
}));

/** Find the command bound to a key event, if any. */
export function commandForKey(e: KeyLike, mac = isMac): CommandSpec | null {
  for (const { spec, keys } of PARSED) if (keys.some((k) => matchShortcut(e, k, mac))) return spec;
  return null;
}

/** Validate a string coming from native menus / IPC. */
export function isCommandId(s: string): s is CommandId {
  return BY_ID.has(s as CommandId) || s.startsWith('theme:') || /^heading:[0-6]$/.test(s);
}
