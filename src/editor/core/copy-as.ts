/**
 * Edit › Copy as … / Paste as Plain Text (#96), on top of the rich copy (#79).
 *
 * A menu command is not a clipboard event, so the payload is written by
 * running `document.execCommand('copy'|'paste')` with a one-shot capture
 * listener that fills / reads the event's DataTransfer (works whenever the
 * engine grants the command: user gesture, permission or embedder setting).
 * When the engine refuses, the async Clipboard API is used instead.
 */
import type { CopyAsFormat, NativeClipboardData } from '../../contracts';
import type { EditorCore } from './editor';
import type { SourceModeLike } from './registry';
import { isTextLeaf } from './edit';
import { leafContent, widgetRaw } from './model';
import { selectionMarkdown, selectionHTML, insertMarkdown, MARGIN_MIME } from './clipboard';
import { embeddedMarkdown } from './clipboard-flavors';
import { htmlToRtf } from './clipboard-rtf';
import { esc } from './html';

export type Payload = Record<string, string>;

/** Rendered plain text of an HTML fragment: blocks on their own lines, table cells tab-separated. */
export function htmlToPlain(html: string): string {
  const root = new DOMParser().parseFromString(`<body>${html}</body>`, 'text/html').body;
  root.querySelectorAll('.katex-mathml, annotation, script, style, .md-meta').forEach((n) => n.remove());
  const out: string[] = [];
  let line = '';
  const BLOCK = /^(P|H[1-6]|LI|PRE|BLOCKQUOTE|TR|DIV|TABLE|UL|OL|HR|FIGURE|DT|DD)$/;
  const flush = (blank: boolean, force = false) => {
    if (line.trim() || (force && out.length)) out.push(line.replace(/[ \t]+$/, ''));
    line = '';
    if (blank && out.length && out[out.length - 1] !== '') out.push('');
  };
  const walk = (n: Node, pre: boolean) => {
    if (n.nodeType === 3) {
      const t = pre ? (n as Text).data : (n as Text).data.replace(/\s+/g, ' ');
      line += line.trim() || pre ? t : t.replace(/^ +/, '');
      return;
    }
    if (n.nodeType !== 1) return;
    const el = n as Element;
    const tag = el.tagName;
    if (tag === 'BR') return flush(false, true);
    if (tag === 'IMG') {
      line += el.getAttribute('alt') ?? '';
      return;
    }
    const block = BLOCK.test(tag);
    if (block && line.trim()) flush(false);
    if (tag === 'PRE') {
      const t = (el.textContent ?? '').replace(/\n$/, '');
      for (const l of t.split('\n')) {
        line = l;
        flush(false, true);
      }
      flush(true);
      return;
    }
    let k = 0;
    for (const c of Array.from(el.childNodes)) {
      if (tag === 'TR' && c.nodeType === 1 && k++ > 0) line += '\t';
      walk(c, pre);
    }
    if (block) flush(/^(P|H[1-6]|BLOCKQUOTE|TABLE|UL|OL|PRE|HR|FIGURE)$/.test(tag) && !el.closest('li'));
  };
  walk(root, false);
  if (line) flush(false);
  while (out.length && out[out.length - 1] === '') out.pop();
  return out.join('\n');
}

const WORD_CSS: Record<string, string> = {
  h1: 'font-size:24pt;font-weight:bold;margin:12pt 0 6pt',
  h2: 'font-size:18pt;font-weight:bold;margin:12pt 0 6pt',
  h3: 'font-size:14pt;font-weight:bold;margin:10pt 0 4pt',
  h4: 'font-size:12pt;font-weight:bold',
  h5: 'font-size:11pt;font-weight:bold',
  h6: 'font-size:10pt;font-weight:bold',
  p: 'margin:0 0 8pt',
  pre: 'font-family:Menlo,Consolas,monospace;font-size:10pt;background:#f6f8fa;padding:6pt',
  code: 'font-family:Menlo,Consolas,monospace',
  blockquote: 'margin:0 0 8pt 12pt;padding-left:8pt;border-left:3pt solid #ddd;color:#555',
  table: 'border-collapse:collapse',
  th: 'border:1px solid #999;padding:3pt 6pt;font-weight:bold',
  td: 'border:1px solid #999;padding:3pt 6pt',
  mark: 'background:yellow',
};

/** HTML for word processors: inline styles per element + an Office-friendly document wrapper. */
export function wordHtml(html: string): string {
  const doc = new DOMParser().parseFromString(`<body>${html}</body>`, 'text/html');
  doc.querySelectorAll('*').forEach((el) => {
    const css = WORD_CSS[el.tagName.toLowerCase()];
    if (css) el.setAttribute('style', css + (el.getAttribute('style') ? ';' + el.getAttribute('style') : ''));
  });
  return (
    '<html xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:w="urn:schemas-microsoft-com:office:word">' +
    '<head><meta charset="utf-8"><meta name="ProgId" content="Word.Document"></head>' +
    `<body style="font-family:Calibri,Helvetica,Arial,sans-serif;font-size:11pt">${doc.body.innerHTML}</body></html>`
  );
}

/** TeX of the math block / inline `$…$` at the caret (or exactly selected), plus whether it is display math. */
export function mathAtCaret(ed: EditorCore): { tex: string; display: boolean } | null {
  const doc = ed.doc;
  if (!doc.leaves.length) return null;
  const s = ed.readSel() ?? ed.lastSel ?? { anchor: 0, focus: 0 };
  const { i, off } = doc.locate(s.focus);
  const l = doc.leaves[i];
  if (!l) return null;
  if (l.type === 'math_block') {
    const raw = widgetRaw(l).replace(/\n+$/, '');
    const m = /^\s*\$\$([\s\S]*?)\$\$\s*$/.exec(raw);
    return { tex: (m ? m[1] : raw).replace(/^\n|\n$/g, ''), display: true };
  }
  if (!isTextLeaf(l)) return null;
  const c = leafContent(l);
  const re = /(?<![\\$])\$(?!\$)((?:\\.|[^$\\\n])+?)\$(?!\$)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(c))) if (off >= m.index && off <= m.index + m[0].length) return { tex: m[1], display: false };
  return null;
}

/** MathML of `tex` through the registered inline math renderer (KaTeX's MathML output), or an annotation-only fallback. */
export function texToMathML(ed: EditorCore, tex: string, display: boolean): string {
  const r = ed.view.inlineCtx().inlineMath;
  let math: Element | null = null;
  if (r) {
    const el = document.createElement('span');
    try {
      r(tex, el);
      math = el.querySelector('math');
    } catch {
      math = null;
    }
  }
  if (!math) {
    return `<math xmlns="http://www.w3.org/1998/Math/MathML"${display ? ' display="block"' : ''}><semantics><mtext>${esc(tex)}</mtext><annotation encoding="application/x-tex">${esc(tex)}</annotation></semantics></math>`;
  }
  if (!math.getAttribute('xmlns')) math.setAttribute('xmlns', 'http://www.w3.org/1998/Math/MathML');
  if (display) math.setAttribute('display', 'block');
  return math.outerHTML;
}

/** Image (`![alt](src)`) at the caret or in the selection, with its src resolved for loading. */
export function imageAtCaret(ed: EditorCore): { src: string; url: string; alt: string } | null {
  const doc = ed.doc;
  if (!doc.leaves.length) return null;
  const { from, to } = ed.sel();
  const a = doc.locate(from);
  const l = doc.leaves[a.i];
  if (!l || !isTextLeaf(l)) return null;
  const b = doc.locate(to);
  const c = leafContent(l);
  const end = b.i === a.i ? b.off : c.length;
  const re = /!\[([^\]\n]*)\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(c))) {
    const s0 = m.index;
    const s1 = s0 + m[0].length;
    if ((a.off >= s0 && a.off <= s1) || (s0 >= a.off && s1 <= end && end > a.off)) {
      const src = m[2];
      return { src, url: ed.settings.resolveAsset(src), alt: m[1] };
    }
  }
  return null;
}

/** Payload of a copy-as format, or null when there is nothing to copy (no selection / no math / no image). */
export function copyPayload(ed: EditorCore, format: Exclude<CopyAsFormat, 'image'>): Payload | null {
  if (format === 'tex' || format === 'mathml') {
    const m = mathAtCaret(ed);
    if (!m) return null;
    if (format === 'tex') return { 'text/plain': m.tex };
    const mml = texToMathML(ed, m.tex, m.display);
    return { 'text/plain': mml };
  }
  const sel = selectionMarkdown(ed);
  if (!sel) return null;
  if (format === 'markdown') return { 'text/plain': sel.md };
  // #127 "When copy / export as HTML (without style)": "Use LaTeX Source" keeps $$…$$ / $…$
  const mathSource = format === 'html' || format === 'unstyled';
  const latex = ed.settings.markdown?.mathCopyFormat === 'latex';
  const html = selectionHTML(ed, sel.md, mathSource && latex);
  switch (format) {
    case 'html':
      return { 'text/plain': html };
    case 'plain':
      return { 'text/plain': htmlToPlain(html) };
    case 'unstyled':
      return { 'text/plain': htmlToPlain(html), 'text/html': html };
    case 'word': {
      const p: Payload = { 'text/plain': htmlToPlain(html), 'text/html': wordHtml(html) };
      try {
        p['text/rtf'] = htmlToRtf(html);
      } catch {
        /* RTF is a bonus flavour */
      }
      return p;
    }
  }
}

/** Last payload written by copy-as (tests / native fallbacks read it). */
export const lastCopyAs = new WeakMap<EditorCore, Payload>();

/** Settings slice for the #116 native fallback (`EditorSettings` satisfies it). */
interface NativeClipboard {
  writeClipboardNative?(data: NativeClipboardData): Promise<boolean>;
  docUrl?: string | null;
}

/** Write `p` to the system clipboard. Resolves false when every path was refused. */
export async function writePayload(p: Payload, native?: NativeClipboard): Promise<boolean> {
  let done = false;
  const h = (e: Event) => {
    const dt = (e as ClipboardEvent).clipboardData;
    if (!dt) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    for (const [t, v] of Object.entries(p)) {
      try {
        dt.setData(t, v);
      } catch {
        /* unknown types may be rejected */
      }
    }
    done = true;
  };
  document.addEventListener('copy', h, { capture: true });
  try {
    document.execCommand('copy');
  } catch {
    /* refused */
  } finally {
    document.removeEventListener('copy', h, { capture: true });
  }
  if (done) return true;
  const cb = navigator.clipboard;
  try {
    if (cb?.write && typeof ClipboardItem !== 'undefined') {
      const items: Record<string, Blob> = {};
      for (const t of ['text/plain', 'text/html']) if (t in p) items[t] = new Blob([p[t]], { type: t });
      await cb.write([new ClipboardItem(items)]);
      return true;
    }
    if (cb?.writeText) {
      await cb.writeText(p['text/plain'] ?? '');
      return true;
    }
  } catch {
    /* refused */
  }
  // #116: WKWebView refuses execCommand('copy') without user activation (native
  // menu item / palette); overwrite the pasteboard directly (Typora clipboard.write).
  const w = native?.writeClipboardNative;
  if (!w) return false;
  try {
    return await w({
      plain: p['text/plain'] ?? '',
      ...(p['text/html'] ? { html: p['text/html'] } : {}),
      ...(p['text/rtf'] ? { rtf: p['text/rtf'] } : {}),
      ...(p[MARGIN_MIME] ? { markdown: p[MARGIN_MIME] } : {}),
      ...(native.docUrl ? { baseUrl: native.docUrl } : {}),
    });
  } catch {
    return false;
  }
}

async function imagePng(url: string): Promise<Blob> {
  const img = new Image();
  img.crossOrigin = 'anonymous';
  img.src = url;
  await img.decode();
  const c = document.createElement('canvas');
  c.width = img.naturalWidth || 1;
  c.height = img.naturalHeight || 1;
  c.getContext('2d')!.drawImage(img, 0, 0);
  return await new Promise<Blob>((res, rej) => c.toBlob((b) => (b ? res(b) : rej(new Error('toBlob'))), 'image/png'));
}

/** Copy the image at the caret as PNG data (plus its path as text). */
async function copyImage(ed: EditorCore, img: { src: string; url: string; alt: string }): Promise<boolean> {
  lastCopyAs.set(ed, { 'text/plain': img.src });
  try {
    const png = await imagePng(img.url);
    await navigator.clipboard.write([new ClipboardItem({ 'image/png': png, 'text/plain': new Blob([img.src], { type: 'text/plain' }) })]);
    return true;
  } catch {
    return writePayload({ 'text/plain': img.src }, ed.settings);
  }
}

export function copyAs(ed: EditorCore, format: CopyAsFormat): boolean {
  if (format === 'image') {
    const img = imageAtCaret(ed);
    if (!img) return false;
    void copyImage(ed, img);
    return true;
  }
  const p = copyPayload(ed, format);
  if (!p) return false;
  lastCopyAs.set(ed, p);
  // word processors on macOS get real RTF through the native rich-copy path (#79)
  const rich = format === 'word' ? ed.settings.writeClipboardRich : undefined;
  if (rich && p['text/html'] && p['text/rtf']) {
    const nonce = `w${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
    p['text/html'] = p['text/html'].replace('<body ', `<body data-margin-copy="${nonce}" `);
    void writePayload(p, ed.settings).then(() => rich({ plain: p['text/plain'], html: p['text/html'], rtf: p['text/rtf'], markdown: '', marker: nonce }).catch(() => false));
    return true;
  }
  void writePayload(p, ed.settings);
  return true;
}

// ------------------------------------------------------------- paste as plain text

/** Plain text to insert from clipboard flavours: Margin/HTML content is reduced to its rendered text. */
export function plainFromClipboard(get: (t: string) => string): string {
  let html = '';
  try {
    html = get('text/html');
  } catch {
    html = '';
  }
  let priv = '';
  try {
    priv = get(MARGIN_MIME);
  } catch {
    priv = '';
  }
  const fromMargin = priv || (html && embeddedMarkdown(html));
  if (fromMargin && html) {
    const inner = new DOMParser().parseFromString(html, 'text/html').querySelector('[data-margin-md]');
    return htmlToPlain(inner ? inner.innerHTML : html);
  }
  return get('text/plain') || (html ? htmlToPlain(html) : '');
}

export function pastePlain(ed: EditorCore): boolean {
  const range = ed.sel();
  let done = false;
  const h = (e: Event) => {
    const dt = (e as ClipboardEvent).clipboardData;
    if (!dt) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    done = true;
    const t = plainFromClipboard((x) => dt.getData(x)).replace(/\r\n?/g, ed.doc.eol);
    if (t) insertMarkdown(ed, t, range);
  };
  document.addEventListener('paste', h, { capture: true });
  try {
    document.execCommand('paste');
  } catch {
    /* refused */
  } finally {
    document.removeEventListener('paste', h, { capture: true });
  }
  if (done) return true;
  void readClipboardPlain(ed).then((t) => {
    if (t) insertMarkdown(ed, t.replace(/\r\n?/g, ed.doc.eol), range);
  });
  return true;
}

async function readClipboardPlain(ed: EditorCore): Promise<string> {
  // native pasteboard (desktop): no paste callout, sees RTF from rich apps too
  if (ed.settings.readClipboard) {
    try {
      const s = await ed.settings.readClipboard();
      if (s) return plainFromClipboard((t) => (t === 'text/plain' ? (s.plain ?? '') : t === 'text/html' ? (s.html ?? s.rtfHtml ?? '') : ''));
    } catch {
      /* fall back to the web clipboard */
    }
  }
  const cb = navigator.clipboard;
  try {
    if (cb?.read) {
      const items = await cb.read();
      const got: Record<string, string> = {};
      for (const it of items) for (const t of it.types) if (t.startsWith('text/') || t === MARGIN_MIME) got[t] ??= await (await it.getType(t)).text();
      return plainFromClipboard((t) => got[t] ?? '');
    }
  } catch {
    /* fall back to readText */
  }
  try {
    return (await cb?.readText?.()) ?? '';
  } catch {
    return '';
  }
}


// ------------------------------------------------------------- source mode (#116)

/**
 * Copy as … in source mode: every variant copies the selected source text
 * (fe-contextmenus §1.5); the native payload write covers WKWebView's refusal
 * of execCommand('copy') behind a native menu item.
 */
export function copyAsInSourceMode(ed: EditorCore, s: SourceModeLike): boolean {
  const sel = s.getSelection?.() ?? s.view?.state.selection.main;
  if (!sel || sel.anchor === sel.head) return false;
  const md = s.getMarkdown();
  const text = md.slice(Math.min(sel.anchor, sel.head), Math.max(sel.anchor, sel.head));
  if (!text) return false;
  const p: Payload = { 'text/plain': text };
  lastCopyAs.set(ed, p);
  void writePayload(p, ed.settings);
  return true;
}

/**
 * Paste as Plain Text in source mode: the system plain paste — Typora hands it
 * to WebKit's `pasteAsPlainText:` (clipboard-contextmenu §4.2); Margin reads
 * the pasteboard's plain flavour and replaces the selection.
 */
export function pastePlainInSourceMode(ed: EditorCore, s: SourceModeLike): boolean {
  const replace = s.replaceSelection;
  if (!replace) return false;
  void (async () => {
    let text = '';
    try {
      text = (await ed.settings.readClipboard?.())?.plain ?? '';
    } catch {
      /* fall back to the web clipboard */
    }
    if (!text) {
      try {
        text = (await navigator.clipboard?.readText?.()) ?? '';
      } catch {
        return;
      }
    }
    if (text) replace(text.replace(/\r\n?/g, '\n'));
  })();
  return true;
}
