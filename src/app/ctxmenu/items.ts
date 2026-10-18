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
  /** Image pipeline ops bound to the right-clicked image (see `ImageCtxOps`). */
  imageOps?(t: CtxTarget): ImageCtxOps | null;
  /** `Copy to <folder>` target resolved for the clicked image. */
  imageTarget?(): { label: string; canMove: boolean; run(move: boolean): void } | null;
  zoomChoices?(): { zoomNow: string | null; direct?: string | null; presets: string[]; set(v: string): void } | null;
  syntaxState?(): { isHtml: boolean; switchTo(to: 'markdown' | 'html'): void } | null;
  /** "Save … As…" downloads (#138). */
  saveImageAs?(src: string): void;
  saveMathAs?(): void;
  saveVideoAs?(src: string): void;
  /** Widget actions (table tools, edit, diagram image). */
  tableAction(action: TableAction): void;
  editBlock(): void;
  copyDiagramImage(): void;
  saveDiagram(): void;
}
/** Image operations for one right-clicked image, provided by the image feature. */
export interface ImageCtxOps {
  /** "Copy Image to…" / "Rename or Move Image to…" save dialogs. */
  copyTo(move: boolean): void;
  /** `Copy to <folder>` / `Move to <folder>` quick target (null = none). */
  target(): { label: string; canMove: boolean; run(move: boolean): void } | null;
  /** Zoom ▸ state for this image (null = not zoomable). `direct` is the "Zoom Image
   * to N%" entry: the explicit style zoom, else 100/pixel-ratio (#155, §1.3). */
  zoom(): { zoomNow: string | null; direct?: string | null; presets: string[]; set(v: string): void } | null;
  /** Switch Image Syntax ▸ state (null = not switchable). */
  syntax(): { isHtml: boolean; switchTo(to: 'markdown' | 'html'): void } | null;
  /** "Save Image As…" */
  saveAs(): void;
  /** Delete Image / Delete Image File (confirm + Trash) via the image tools. */
  remove(withFile: boolean): void;
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
    label: 'Copy / Paste As…',
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
  out.push({ id: 'cut', label: 'Cut', hint: formatShortcut('Mod+X'), disabled: !hasSel, run: () => a.cut() });
  out.push({ id: 'copy', label: 'Copy', hint: formatShortcut('Mod+C'), disabled: !hasSel, run: () => a.copy() });
  if (t.kind === 'image' && t.loaded !== false)
    out.push({ id: 'copyImg', label: 'Copy Image Content', run: () => (a.restore(), a.run('copyAs:image')) });
  if (t.kind === 'link' && t.href !== undefined) out.push({ id: 'copyLink', label: 'Copy Link Address', run: () => a.writeText(t.href!) });
  out.push({ id: 'paste', label: 'Paste', hint: formatShortcut('Mod+V'), run: () => a.paste() });
  if (t.kind !== 'input') out.push(copyPasteAs(a, hasSel));
  // remaining system items (WebKit's "Search with Google" for a text selection)
  const q = s.selection.trim();
  if (q && t.kind !== 'input') out.push(sep, { id: 'searchGoogle', label: 'Search with Google', run: () => a.openExternal('https://www.google.com/search?q=' + encodeURIComponent(q)) });
  return out;
}

/** Table ▸ submenu (#140): every entry is an EditorCommand, so menu, palette and the
 * native menu share one implementation (ops act on the table with the caret). */
function tableMenu(a: CtxActions): MenuItem {
  const t = (op: TableAction, label: string, keys?: string): MenuItem => ({
    id: 'table:' + op,
    label,
    hint: keys ? formatShortcut(keys) : undefined,
    run: () => (a.restore(), a.exec({ kind: 'table', op: op === 'deleteTable' ? 'delete' : op })),
  });
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
      { id: 'table:copy', label: 'Copy Table', run: () => (a.restore(), a.exec({ kind: 'table', op: 'copy' })) },
      { id: 'table:prettify', label: 'Prettify Source Code', run: () => (a.restore(), a.exec({ kind: 'table', op: 'prettify' })) },
      { id: 'table:delete', label: 'Delete Table', run: () => (a.restore(), a.exec({ kind: 'table', op: 'delete' })) },
    ],
  };
}

/** Code Tools ▸ (#140): Copy Code Content, Auto Indent Whole / Selected Code (fence, math and HTML blocks). */
function codeTools(a: CtxActions): MenuItem {
  const c = (op: 'copy' | 'indentAll' | 'indentSelected', label: string): MenuItem => ({
    id: 'code:' + op,
    label,
    run: () => (a.restore(), a.exec({ kind: 'code', op })),
  });
  return {
    id: 'code-tools',
    label: 'Code Tools',
    submenu: [c('copy', 'Copy Code Content'), c('indentAll', 'Auto Indent Whole Code'), c('indentSelected', 'Auto Indent Selected Code')],
  };
}

/** Copy Math ▸ (#127): Copy as Tex / MathML / Image — block and inline variants share the
 * caret-based MathOp commands; Copy as Image rasterizes through the app (KaTeX → PNG). */
function copyMath(a: CtxActions, inline: boolean): MenuItem {
  const c = (id: CommandId, label: string): MenuItem => ({ id, label, run: () => (a.restore(), a.run(id)) });
  const items = [c('copyAs:tex', 'Copy as Tex'), c('copyAs:mathml', 'Copy as MathML'), c('math:copyImage', 'Copy as Image')];
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
      return a.saveMathAs ? { id: key, label: 'Save Math As…', run: () => a.saveMathAs!() } : null;
    case 'download-image':
      return a.saveImageAs ? { id: key, label: 'Save Image As…', run: () => a.saveImageAs!(src) } : null;
    case 'download-video':
      return a.saveVideoAs ? { id: key, label: 'Save Video As…', run: () => a.saveVideoAs!(src) } : null;
    case 'insertParagraphBefore':
      return block('para:insertBefore', 'Insert Paragraph Before');
    case 'insertParagraphAfter':
      return block('para:insertAfter', 'Insert Paragraph After');
    case 'delete':
      return block('delete:block', 'Delete');
    case 'deleteFences':
      return block('delete:block', 'Delete Code Block');
    case 'revealImgInFinder':
      return a.revealImage ? { id: key, label: 'Open Image Location…', run: () => a.revealImage!(src) } : null;
    case 'revealImgInBrowser':
      return { id: key, label: 'Open Image in Browser…', run: () => a.openExternal(src) };
    case 'zoomImg': {
      const z = a.zoomChoices?.();
      if (!z) return null;
      const sub: MenuItem[] = [];
      z.presets.forEach((v, i) => {
        sub.push({ id: `zoomImg:${v}`, label: v, checked: v === z.zoomNow, run: () => z.set(v) });
        if (i === 3) sub.push(sep); // 25 33 50 67 | 100 150 200 (fe-contextmenus-tools §1.2)
      });
      // §1.2/§1.3: direct entry — current zoom, or 1/scale for Retina images (#155)
      const direct = z.direct ?? z.zoomNow;
      return [
        ...(direct ? [{ id: 'zoomImg:now', label: `Zoom Image to ${direct}`, run: () => z.set(direct) } as MenuItem] : []),
        { id: key, label: 'Zoom Image', submenu: sub },
      ];
    }
    case 'imgSyntax': {
      const s = a.syntaxState?.();
      if (!s) return null;
      return { id: key, label: 'Switch Image Syntax', submenu: [
        { id: 'imgSyntax:md', label: 'Markdown Style', checked: !s.isHtml, run: () => s.switchTo('markdown') },
        { id: 'imgSyntax:html', label: 'HTML Style', checked: s.isHtml, run: () => s.switchTo('html') },
      ] };
    }
    case 'copyImgToDir': {
      const target = a.imageTarget?.() ?? null;
      return target ? { id: key, label: `Copy to ${target.label}`, run: () => target.run(false) } : null;
    }
    case 'copyImgToSelect':
      return a.copyImageTo ? { id: key, label: 'Copy Image to…', run: () => a.copyImageTo!(src, false) } : null;
    case 'moveImgToDir': {
      const target = a.imageTarget?.() ?? null;
      return target?.canMove ? { id: key, label: `Move to ${target.label}`, run: () => target.run(true) } : null;
    }
    case 'moveImgToSelect':
      return a.copyImageTo ? { id: key, label: 'Rename or Move Image to…', run: () => a.copyImageTo!(src, true) } : null;
    case 'uploadImg':
      return a.uploadImage ? { id: key, label: 'Upload Image', run: () => a.uploadImage!(src) } : null;
    case 'deleteImg':
      return { id: key, label: 'Delete Image', run: () => a.deleteImage(false) };
    case 'deleteImgFile':
      return { id: key, label: 'Delete Image File', run: () => a.deleteImage(true) };
    default:
      if (key.startsWith('copyEmoji-')) return { id: 'copyEmoji', label: `Copy '${key.slice(10)}'`, run: () => a.writeText(key.slice(10)) };
      break;
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
