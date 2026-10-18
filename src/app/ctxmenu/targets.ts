/**
 * Editor context-menu targets (#97): which element was right-clicked and the
 * Typora-style key list describing the menu (typora-re clipboard-contextmenu
 * §6.1). `'normal'` is the slot for the default edit items (Cut / Copy / Paste
 * and Copy / Paste As), `'|'` a separator. The key list is pure data so it can
 * be unit-tested; `items.ts` maps keys to menu items.
 */

export type CtxKind =
  | 'none'
  | 'input'
  | 'text'
  | 'link'
  | 'image'
  | 'mathInline'
  | 'table'
  | 'code'
  | 'math'
  | 'diagram'
  | 'html'
  | 'atomic';

export interface CtxTarget {
  kind: CtxKind;
  keys: string[];
  /** Top-level `.md-block[data-bid]` under the pointer (null in source mode / inputs). */
  block: HTMLElement | null;
  /** Widget type (`data-type`) or text block type of `block`. */
  blockType: string | null;
  href?: string;
  /** Rendered `<img>` and the inline wrap holding its markdown source. */
  img?: HTMLImageElement;
  imageWrap?: HTMLElement;
  /** Image src as written in the markdown (`![](src)` or `<img src>`). */
  src?: string;
  /** Image is a local file (not http(s) / data:). */
  local?: boolean;
  /** Inline math wrap. */
  math?: HTMLElement;
  /** Table cell under the pointer (row / column), when inside a table widget. */
  cell?: HTMLElement;
}

export const IPB = 'insertParagraphBefore';
export const IPA = 'insertParagraphAfter';

/** Atomic (tab-focusable) blocks: insert paragraph before / after + delete. */
const ATOMIC_TYPES = new Set(['front_matter', 'toc', 'hr']);

/** Context keys for a widget block type (null = not a widget). */
export function blockKeys(type: string): { kind: CtxKind; keys: string[] } | null {
  switch (type) {
    case 'table':
      return { kind: 'table', keys: ['|', 'table', '|', IPB, IPA] };
    case 'html_block':
      return { kind: 'html', keys: ['|', 'edit', 'code-tools', '|', IPB, IPA, 'delete'] };
    case 'math_block':
      return { kind: 'math', keys: ['|', 'edit', 'copyMathBlock', 'download-math', 'code-tools', '|', IPB, IPA, 'delete'] };
    case 'diagram':
      return { kind: 'diagram', keys: ['|', 'edit', 'copy-as-image', 'download-diagram', 'code-tools', '|', IPB, IPA, 'deleteFences'] };
    case 'code_fence':
      return { kind: 'code', keys: ['|', 'code-tools', '|', IPB, IPA, 'deleteFences'] };
  }
  if (ATOMIC_TYPES.has(type)) return { kind: 'atomic', keys: ['|', IPB, IPA, 'delete'] };
  return null;
}

/** True for a text field that is not part of the document (find bar, dialogs, source mode textarea). */
function isField(el: Element): boolean {
  if (el instanceof HTMLInputElement) return !['checkbox', 'radio', 'button', 'submit', 'range', 'color', 'file'].includes(el.type);
  return el instanceof HTMLTextAreaElement;
}

/**
 * Compute the menu for a right-click on `target`. `root` is the WYSIWYG editor
 * root (`.md-editor`); `sourceHost` the source-mode host when source mode is on.
 * Returns kind 'none' (no in-app menu) for targets outside the editor.
 */
export function contextTarget(target: EventTarget | null, root: HTMLElement | null, sourceHost: HTMLElement | null = null): CtxTarget {
  const none: CtxTarget = { kind: 'none', keys: [], block: null, blockType: null };
  if (!(target instanceof Element)) return none;
  if (sourceHost?.contains(target)) return { ...none, kind: 'input', keys: ['input'] };
  if (!root || !root.contains(target)) return isField(target) ? { ...none, kind: 'input', keys: ['input'] } : none;

  let block: HTMLElement | null = target.closest<HTMLElement>('[data-bid]');
  while (block && block.parentElement !== root && block.parentElement) {
    const up = block.parentElement.closest<HTMLElement>('[data-bid]');
    if (!up || !root.contains(up)) break;
    block = up;
  }
  if (block && !root.contains(block)) block = null;
  const blockType = block?.dataset.type ?? null;
  const base: CtxTarget = { ...none, kind: 'text', keys: ['normal'], block, blockType };

  const w = blockType ? blockKeys(blockType) : null;
  if (w) {
    const t: CtxTarget = { ...base, kind: w.kind, keys: ['normal', ...w.keys] };
    if (w.kind === 'table') t.cell = target.closest<HTMLElement>('.mb-cell') ?? undefined;
    return t;
  }

  const img = target.closest('img');
  const imageWrap = img?.closest<HTMLElement>('.md-image') ?? undefined;
  if (img && imageWrap) {
    const src = imageMarkdownSrc(imageWrap.querySelector('.md-src')?.textContent ?? '') ?? img.getAttribute('src') ?? '';
    const local = !/^([a-z][\w+.-]*:|\/\/)/i.test(src) || /^file:/i.test(src);
    return {
      ...base,
      kind: 'image',
      img,
      imageWrap,
      src,
      local,
      keys: [
        local ? 'revealImgInFinder' : 'revealImgInBrowser',
        'copyImgToSelect',
        'moveImgToSelect',
        'uploadImg',
        'copyImg',
        'zoomImg',
        'imgSyntax',
        local ? 'deleteImgFile' : 'deleteImg',
        '|',
        'normal',
        'download-image',
      ],
    };
  }

  const link = target.closest<HTMLElement>('.md-link');
  if (link && link.dataset.href !== undefined) return { ...base, kind: 'link', href: link.dataset.href, keys: ['openLink', 'copyLink', '|', 'normal'] };

  const math = target.closest<HTMLElement>('.md-math');
  if (math) return { ...base, kind: 'mathInline', math, keys: ['normal', '|', 'copyMathInline'] };

  return base;
}

/** The src of a markdown image `![alt](src "title")` / `<img src="…">` source, or null. */
export function imageMarkdownSrc(raw: string): string | null {
  const md = /^!\[[^\]]*\]\(\s*(<[^>]*>|[^\s)]+)/.exec(raw);
  if (md) return md[1].replace(/^<|>$/g, '');
  const html = /<img\b[^>]*?\bsrc\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(raw);
  return html ? (html[1] ?? html[2] ?? html[3]) : null;
}
