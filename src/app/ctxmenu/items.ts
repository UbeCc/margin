/**
 * Context-menu keys → menu items (#97). Labels and grouping follow Typora's
 * macOS menus (typora-re clipboard-contextmenu §6.4–§6.6): the `normal` slot is
 * Cut / Copy / Paste with Copy Image Content and Copy Link Address next to
 * Copy, then the Copy / Paste As submenu (not in source mode / text fields).
 */
import type { EditorCommand } from '../../contracts';
import type { CommandId } from '../commands';
import { commandSpec } from '../commands';
import { formatShortcut } from '../util/keymap';
import type { MenuItem } from '../ui/contextmenu';
import type { CtxTarget } from './targets';

/** What the menu needs from the shell. */
export interface CtxActions {
  run(id: CommandId): unknown;
  exec(cmd: EditorCommand): boolean;
  /** Re-apply the selection / focus captured when the menu opened. */
  restore(): void;
  cut(): void;
  copy(): void;
  paste(): void;
  writeText(text: string): void;
  openLink(href: string): void;
  openExternal(url: string): void;
  /** Image actions; absent ones are shown disabled. */
  revealImage?(src: string): void;
  uploadImage?(src: string): void;
  deleteImage(withFile: boolean): void;
  copyImageTo?(src: string, move: boolean): void;
  /** Widget actions (table tools, edit, diagram image). */
  tableAction(action: TableAction): void;
  editBlock(): void;
  copyDiagramImage(): void;
  saveDiagram(): void;
}

export type TableAction = 'rowAbove' | 'rowBelow' | 'colBefore' | 'colAfter' | 'deleteRow' | 'deleteCol' | 'deleteTable';

export interface CtxState {
  /** Selected text when the menu opened. */
  selection: string;
}

const hint = (id: CommandId): string | undefined => {
  const k = commandSpec(id)?.keys?.[0];
  return k ? formatShortcut(k) : undefined;
};

const sep: MenuItem = { separator: true };

/** The Copy / Paste As submenu (Typora `moreCopyPasteItem`). */
function copyPasteAs(a: CtxActions, hasSel: boolean): MenuItem {
  const c = (id: CommandId, label: string, needsSel = true): MenuItem => ({
    id,
    label,
    hint: hint(id),
    disabled: needsSel && !hasSel,
    run: () => {
      a.restore();
      a.run(id);
    },
  });
  return {
    id: 'moreCopyPaste',
    label: 'Copy / Paste As',
    submenu: [
      c('copyAs:markdown', 'Copy as Markdown'),
      c('copyAs:html', 'Copy as HTML Code'),
      c('copyAs:unstyled', 'Copy without Theme Styling'),
      sep,
      c('pastePlain', 'Paste as Plain Text', false),
    ],
  };
}

/** The default edit items that replace the WebKit menu (`normal` / `input`). */
function editItems(t: CtxTarget, s: CtxState, a: CtxActions): MenuItem[] {
  const hasSel = s.selection.length > 0;
  const out: MenuItem[] = [];
  const q = s.selection.trim();
  if (q && t.kind !== 'input') {
    out.push({ id: 'searchGoogle', label: 'Search with Google', run: () => a.openExternal('https://www.google.com/search?q=' + encodeURIComponent(q)) }, sep);
  }
  out.push({ id: 'cut', label: 'Cut', hint: formatShortcut('Mod+X'), disabled: !hasSel, run: () => a.cut() });
  out.push({ id: 'copy', label: 'Copy', hint: formatShortcut('Mod+C'), disabled: !hasSel, run: () => a.copy() });
  if (t.kind === 'image')
    out.push({ id: 'copyImg', label: 'Copy Image Content', run: () => (a.restore(), a.run('copyAs:image')) });
  if (t.kind === 'link' && t.href !== undefined) out.push({ id: 'copyLink', label: 'Copy Link Address', run: () => a.writeText(t.href!) });
  out.push({ id: 'paste', label: 'Paste', hint: formatShortcut('Mod+V'), run: () => a.paste() });
  if (t.kind !== 'input') out.push(copyPasteAs(a, hasSel));
  return out;
}

function tableMenu(a: CtxActions): MenuItem {
  const t = (id: TableAction, label: string, keys?: string): MenuItem => ({ id: 'table:' + id, label, hint: keys ? formatShortcut(keys) : undefined, run: () => a.tableAction(id) });
  return {
    id: 'table',
    label: 'Table',
    submenu: [
      t('rowAbove', 'Add Row Above'),
      t('rowBelow', 'Add Row Below', 'Mod+Enter'),
      sep,
      t('colBefore', 'Add Column Before'),
      t('colAfter', 'Add Column After'),
      sep,
      t('deleteRow', 'Delete Row', 'Mod+Shift+Backspace'),
      t('deleteCol', 'Delete Column'),
      sep,
      { id: 'table:copy', label: 'Copy Table', run: () => (a.restore(), a.exec({ kind: 'copyBlock', part: 'source' })) },
      { id: 'table:prettify', label: 'Prettify Source Code', disabled: true, run: () => {} },
      { id: 'table:delete', label: 'Delete Table', run: () => a.tableAction('deleteTable') },
    ],
  };
}

function codeTools(a: CtxActions): MenuItem {
  return {
    id: 'code-tools',
    label: 'Code Tools',
    submenu: [
      { id: 'copyCode', label: 'Copy Code Content', run: () => (a.restore(), a.exec({ kind: 'copyBlock', part: 'content' })) },
      { id: 'indentAll', label: 'Auto Indent Whole Code', disabled: true, run: () => {} },
      { id: 'indentSelected', label: 'Auto Indent Selected Code', disabled: true, run: () => {} },
    ],
  };
}

function copyMath(a: CtxActions, inline: boolean): MenuItem {
  const c = (id: CommandId, label: string): MenuItem => ({ id, label, run: () => (a.restore(), a.run(id)) });
  const items = [c('copyAs:tex', 'Copy as Tex'), c('copyAs:mathml', 'Copy as MathML')];
  if (inline) items.push({ id: 'copyAsImageInline', label: 'Copy as Image', disabled: true, run: () => {} });
  return { id: inline ? 'copyMathInline' : 'copyMathBlock', label: 'Copy Math', submenu: items };
}

/** Map one key to its item (null = not shown in Margin). */
export function itemForKey(key: string, t: CtxTarget, s: CtxState, a: CtxActions): MenuItem | MenuItem[] | null {
  const block = (id: CommandId, label: string): MenuItem => ({ id: key, label, run: () => (a.restore(), a.run(id)) });
  const src = t.src ?? '';
  switch (key) {
    case '|':
      return sep;
    case 'normal':
    case 'input':
      return editItems(t, s, a);
    case 'openLink':
      return { id: key, label: 'Open Link', run: () => a.openLink(t.href ?? '') };
    case 'copyLink':
    case 'copyImg':
      return null; // placed next to Copy by editItems
    case 'table':
      return tableMenu(a);
    case 'code-tools':
      return codeTools(a);
    case 'copyMathBlock':
      return copyMath(a, false);
    case 'copyMathInline':
      return copyMath(a, true);
    case 'edit':
      return { id: key, label: 'Edit', run: () => a.editBlock() };
    case 'copy-as-image':
      return { id: key, label: 'Copy as Image', run: () => a.copyDiagramImage() };
    case 'download-diagram':
      return { id: key, label: 'Save Diagram As…', run: () => a.saveDiagram() };
    case 'download-math':
    case 'download-image':
      return null; // not supported yet (#97 gap)
    case 'insertParagraphBefore':
      return block('para:insertBefore', 'Insert Paragraph Before');
    case 'insertParagraphAfter':
      return block('para:insertAfter', 'Insert Paragraph After');
    case 'delete':
      return block('delete:block', 'Delete');
    case 'deleteFences':
      return block('delete:block', 'Delete Code Block');
    case 'revealImgInFinder':
      return { id: key, label: 'Open Image Location', disabled: !a.revealImage, run: () => a.revealImage?.(src) };
    case 'revealImgInBrowser':
      return { id: key, label: 'Open Image in Browser', run: () => a.openExternal(src) };
    case 'copyImgToSelect':
      return { id: key, label: 'Copy Image to…', disabled: !a.copyImageTo, run: () => a.copyImageTo?.(src, false) };
    case 'moveImgToSelect':
      return { id: key, label: 'Move Image to…', disabled: !a.copyImageTo, run: () => a.copyImageTo?.(src, true) };
    case 'uploadImg':
      return { id: key, label: 'Upload Image', disabled: !a.uploadImage || !t.local, run: () => a.uploadImage?.(src) };
    case 'zoomImg':
    case 'imgSyntax':
      return null; // image zoom / syntax switch: image pipeline (#99)
    case 'deleteImg':
      return { id: key, label: 'Delete Image', run: () => a.deleteImage(false) };
    case 'deleteImgFile':
      return { id: key, label: 'Delete Image File', run: () => a.deleteImage(true) };
  }
  return null;
}

/** Build the full menu for a target. */
export function buildItems(t: CtxTarget, s: CtxState, a: CtxActions): MenuItem[] {
  const out: MenuItem[] = [];
  for (const k of t.keys) {
    const it = itemForKey(k, t, s, a);
    if (Array.isArray(it)) out.push(...it);
    else if (it) out.push(it);
  }
  return out;
}
