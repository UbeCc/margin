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
  /** Image loaded (error images keep only reveal / zoom / syntax / delete). */
  loaded?: boolean;
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
export function contextTarget(
  target: EventTarget | null,
  root: HTMLElement | null,
  sourceHost: HTMLElement | null = null,
  point?: { x: number; y: number },
  opts: { uploadFirst?: boolean } = {},
): CtxTarget {
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

  // §1.2 Video: the innermost element wins over its HTML block (system items | Save Video As…).
  const vid = (target as Element).closest?.('video');
  if (vid) return { ...base, kind: 'text', src: vid.getAttribute('src') ?? '', keys: ['normal', '|', 'download-video'] };

  const w = blockType ? blockKeys(blockType) : null;
  if (w) {
    const t: CtxTarget = { ...base, kind: w.kind, keys: ['normal', ...w.keys] };
    if (w.kind === 'table') t.cell = target.closest<HTMLElement>('.mb-cell') ?? undefined;
    return t;
  }
  let el: Element = target;
  if (point && block && !el.closest('.md-wrap')) el = wrapAt(block, point.x, point.y) ?? el;

  const img = el.closest('img');
  if (img) {
    const imageWrap = img.closest<HTMLElement>('.md-image') ?? undefined;
    // Markdown image: exact source from .md-src; HTML-block <img>: its src attribute.
    const src = imageMarkdownSrc(imageWrap?.querySelector('.md-src')?.textContent ?? '') ?? img.getAttribute('src') ?? '';
    const loaded = img.complete && img.naturalWidth > 0;
    const local = !/^([a-z][\w+.-]*:|\/\/)/i.test(src) || /^file:/i.test(src);
    return {
      ...base,
      kind: 'image',
      img,
      imageWrap,
      src,
      local,
      loaded,
      // §1.2: [Upload Image] leads the menu when the target storage is "upload" (#154);
      // otherwise it sits after the copy/move group.
      keys: [
        ...(loaded && opts.uploadFirst ? ['uploadImg'] : []),
        local ? (loaded ? 'revealImgInFinder' : '') : /^https?:/i.test(src) ? 'revealImgInBrowser' : '',
        ...(loaded
          ? [
              'copyImgToDir',
              'copyImgToSelect',
              ...(local ? ['moveImgToDir', 'moveImgToSelect'] : []),
              ...(opts.uploadFirst ? [] : ['uploadImg']),
              '|',
              'copyImg',
            ]
          : []),
        'zoomImg',
        'imgSyntax',
        local ? 'deleteImgFile' : 'deleteImg',
        '|',
        'normal',
        ...(loaded ? ['|', 'download-image'] : []),
      ].filter(Boolean),
    };
  }

  const link = el.closest<HTMLElement>('.md-link');
  if (link && link.dataset.href !== undefined) return { ...base, kind: 'link', href: link.dataset.href, keys: ['openLink', 'copyLink', '|', 'normal'] };

  const emoji = el.closest<HTMLElement>('.md-entity');
  if (emoji) {
    // §1.2 Emoji (:smile: rendered): "Copy '<char>'" before the system items (#139).
    const code = emoji.querySelector('.md-meta')?.textContent ?? '';
    const ch = emoji.querySelector('.md-entity-char')?.textContent ?? '';
    if (/^:[\w+-]+:$/.test(code) && ch) return { ...base, kind: 'text', src: ch, keys: [`copyEmoji-${ch}`, '|', 'normal'] };
  }

  const math = el.closest<HTMLElement>('.md-math');
  if (math) return { ...base, kind: 'mathInline', math, keys: ['copyMathInline', '|', 'normal'] };

  return base;
}

/** The src of a markdown image `![alt](src "title")` / `<img src="…">` source, or null. */
export function imageMarkdownSrc(raw: string): string | null {
  const md = /^!\[[^\]]*\]\(\s*(<[^>]*>|[^\s)]+)/.exec(raw);
  if (md) return md[1].replace(/^<|>$/g, '');
  const html = /<img\b[^>]*?\bsrc\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(raw);
  return html ? (html[1] ?? html[2] ?? html[3]) : null;
}

/** Innermost inline image / math / link wrap of `block` whose box contains (x, y). */
function wrapAt(block: HTMLElement, x: number, y: number): Element | null {
  let best: Element | null = null;
  for (const w of block.querySelectorAll('.md-image, .md-math, .md-link')) {
    const boxes = [...w.getClientRects(), ...[...w.querySelectorAll('.md-math-render, img, .katex')].map((c) => c.getBoundingClientRect())];
    const hit = boxes.some((b) => x >= b.left - 1 && x <= b.right + 1 && y >= b.top - 3 && y <= b.bottom + 3);
    if (hit && (!best || best.contains(w))) best = w;
  }
  return best?.classList.contains('md-image') ? (best.querySelector('img') ?? best) : best;
}
