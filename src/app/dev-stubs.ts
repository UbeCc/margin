/**
 * Development stand-in for the editor core, used ONLY while `src/editor/core`
 * is absent (or when forced with `?stub=editor`). `wiring.ts` picks the real
 * core automatically once it exists, so the integrator does not touch this file.
 *
 *  - createStubEditor: a <textarea>-backed EditorHandle (source-only).
 */
import type { CreateEditor, EditorCommand, EditorHandle, EditorSettings, EditorStats, Heading } from '../contracts';
import { escapeHtml } from './util/dom';

// ------------------------------------------------------------------ editor

const HEADING_RE = /^(#{1,6})[ \t]+(.+?)[ \t#]*$/;

/** Word count: CJK ideographs/kana/hangul count one each; other runs of letters/digits count as words. */
export function countStats(md: string): EditorStats {
  const cjk = md.match(/[぀-ヿ㐀-䶿一-鿿豈-﫿가-힯]/g)?.length ?? 0;
  const latin =
    md
      .replace(/[぀-ヿ㐀-䶿一-鿿豈-﫿가-힯]/g, ' ')
      .match(/[\p{L}\p{N}][\p{L}\p{N}'’_-]*/gu)?.length ?? 0;
  return {
    words: cjk + latin,
    characters: [...md.replace(/\n/g, '')].length,
    lines: md ? md.split('\n').length : 0,
  };
}

function outlineOf(md: string): Heading[] {
  const out: Heading[] = [];
  let fence: string | null = null;
  md.split('\n').forEach((line, i) => {
    const f = /^\s*(```|~~~)/.exec(line);
    if (f) {
      if (!fence) fence = f[1];
      else if (line.trim().startsWith(fence)) fence = null;
      return;
    }
    if (fence) return;
    const m = HEADING_RE.exec(line);
    if (m) out.push({ id: `h-${i}`, level: m[1].length as Heading['level'], text: m[2].replace(/[*_`~=]/g, '') });
  });
  return out;
}

/** Deliberately tiny markdown → HTML, good enough for exporting from the stub. */
export function miniMarkdownToHtml(md: string, resolve: (src: string) => string = (s) => s): string {
  const inline = (s: string): string =>
    escapeHtml(s)
      .replace(/!\[([^\]]*)\]\(([^)\s]+)[^)]*\)/g, (_, alt, src) => `<img alt="${alt}" src="${escapeHtml(resolve(src))}">`)
      .replace(/\[([^\]]+)\]\(([^)\s]+)[^)]*\)/g, '<a href="$2">$1</a>')
      .replace(/`([^`]+)`/g, '<code>$1</code>')
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
      .replace(/\*([^*]+)\*/g, '<em>$1</em>')
      .replace(/~~([^~]+)~~/g, '<del>$1</del>')
      .replace(/==([^=]+)==/g, '<mark>$1</mark>');
  const lines = md.split('\n');
  const html: string[] = [];
  let para: string[] = [];
  let list: 'ul' | 'ol' | null = null;
  const flush = (): void => {
    if (para.length) html.push(`<p>${inline(para.join(' '))}</p>`);
    para = [];
  };
  const endList = (): void => {
    if (list) html.push(`</${list}>`);
    list = null;
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const fence = /^(```|~~~)\s*(\S*)/.exec(line);
    if (fence) {
      flush();
      endList();
      const body: string[] = [];
      for (i++; i < lines.length && !lines[i].startsWith(fence[1]); i++) body.push(lines[i]);
      html.push(`<pre><code${fence[2] ? ` class="language-${escapeHtml(fence[2])}"` : ''}>${escapeHtml(body.join('\n'))}</code></pre>`);
      continue;
    }
    const hm = HEADING_RE.exec(line);
    const li = /^\s*([-*+]|\d+[.)])\s+(.*)$/.exec(line);
    if (hm) {
      flush();
      endList();
      html.push(`<h${hm[1].length} id="h-${i}">${inline(hm[2])}</h${hm[1].length}>`);
    } else if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) {
      flush();
      endList();
      html.push('<hr>');
    } else if (line.startsWith('>')) {
      flush();
      endList();
      html.push(`<blockquote><p>${inline(line.replace(/^>\s?/, ''))}</p></blockquote>`);
    } else if (li) {
      flush();
      const kind = /\d/.test(li[1]) ? 'ol' : 'ul';
      if (list !== kind) {
        endList();
        html.push(`<${kind}>`);
        list = kind;
      }
      const task = /^\[([ xX])\]\s+(.*)$/.exec(li[2]);
      html.push(
        task
          ? `<li class="task-list-item"><input type="checkbox" disabled${task[1] !== ' ' ? ' checked' : ''}> ${inline(task[2])}</li>`
          : `<li>${inline(li[2])}</li>`,
      );
    } else if (!line.trim()) {
      flush();
      endList();
    } else {
      endList();
      para.push(line);
    }
  }
  flush();
  endList();
  return html.join('\n');
}

export const createStubEditor: CreateEditor = (host: HTMLElement, initial: EditorSettings): EditorHandle => {
  let settings: EditorSettings = { ...initial };
  let sourceMode = false;
  const ta = document.createElement('textarea');
  ta.className = 'stub-editor';
  ta.setAttribute('aria-label', 'Document');
  ta.spellcheck = settings.spellcheck;
  ta.placeholder = 'Start writing…';
  host.appendChild(ta);
  host.dataset.stub = 'true';

  const changeCbs = new Set<() => void>();
  const selCbs = new Set<() => void>();
  const autosize = (): void => {
    ta.style.height = 'auto';
    ta.style.height = ta.scrollHeight + 'px';
  };
  const emitChange = (): void => {
    autosize();
    changeCbs.forEach((cb) => cb());
  };
  const emitSel = (): void => selCbs.forEach((cb) => cb());
  ta.addEventListener('input', emitChange);
  for (const ev of ['keyup', 'mouseup', 'focus', 'select']) ta.addEventListener(ev, emitSel);
  const onDocSel = (): void => {
    if (document.activeElement === ta) emitSel();
  };
  document.addEventListener('selectionchange', onDocSel);
  const ro = new ResizeObserver(() => requestAnimationFrame(autosize)); // rAF: avoid "ResizeObserver loop" errors
  ro.observe(host);

  const lineIndexAt = (pos: number): number => ta.value.slice(0, pos).split('\n').length - 1;
  const lineStart = (idx: number): number => {
    const lines = ta.value.split('\n');
    let p = 0;
    for (let i = 0; i < idx && i < lines.length; i++) p += lines[i].length + 1;
    return p;
  };
  const replaceRange = (start: number, end: number, text: string, selStart?: number, selEnd?: number): void => {
    ta.focus();
    ta.setSelectionRange(start, end);
    // execCommand keeps the native undo stack intact.
    const ok = document.execCommand('insertText', false, text);
    if (!ok) {
      ta.setRangeText(text, start, end, 'end');
      emitChange();
    }
    if (selStart !== undefined) ta.setSelectionRange(selStart, selEnd ?? selStart);
  };
  const scrollToLine = (idx: number): void => {
    const lh = parseFloat(getComputedStyle(ta).lineHeight) || 24;
    const scroller = host.closest('.editor-scroll') ?? document.scrollingElement;
    const top = ta.getBoundingClientRect().top - (scroller as Element).getBoundingClientRect().top + (scroller as Element).scrollTop;
    (scroller as Element).scrollTo({ top: top + idx * lh - 80 });
  };
  const marks: Record<string, [string, string]> = {
    strong: ['**', '**'],
    em: ['*', '*'],
    code: ['`', '`'],
    strike: ['~~', '~~'],
    highlight: ['==', '=='],
    link: ['[', '](https://)'],
    underline: ['<u>', '</u>'],
    sub: ['<sub>', '</sub>'],
    sup: ['<sup>', '</sup>'],
    math: ['$', '$'],
    comment: ['<!-- ', ' -->'],
  };
  const blocks: Record<string, string> = {
    quote: '> ',
    ul: '- ',
    ol: '1. ',
    task: '- [ ] ',
  };
  const inserts: Record<string, string> = {
    code: '```\n\n```\n',
    math: '$$\n\n$$\n',
    table: '| Column | Column |\n| --- | --- |\n|  |  |\n',
    hr: '---\n',
    toc: '[TOC]\n',
    front_matter: '---\ntitle: \n---\n',
    html: '<div>\n</div>\n',
    linkRef: '[]: \n',
    footnote: '[^1]: \n',
  };
  let findFrom = -1;

  const exec = (cmd: EditorCommand): boolean => {
    const { selectionStart: s, selectionEnd: e, value } = ta;
    switch (cmd.kind) {
      case 'heading': {
        const li = lineIndexAt(s);
        const ls = lineStart(li);
        const line = value.split('\n')[li] ?? '';
        const stripped = line.replace(/^#{1,6}\s+/, '');
        const prefix = cmd.level ? '#'.repeat(cmd.level) + ' ' : '';
        replaceRange(ls, ls + line.length, prefix + stripped, ls + prefix.length + stripped.length);
        return true;
      }
      case 'mark': {
        const [a, b] = marks[cmd.mark];
        const sel = value.slice(s, e);
        replaceRange(s, e, a + sel + b, s + a.length, s + a.length + sel.length);
        return true;
      }
      case 'block': {
        if (blocks[cmd.block]) {
          const li = lineIndexAt(s);
          const ls = lineStart(li);
          replaceRange(ls, ls, blocks[cmd.block], s + blocks[cmd.block].length);
        } else {
          const text = inserts[cmd.block];
          const ls = lineStart(lineIndexAt(s));
          const pre = s === ls ? '' : '\n';
          replaceRange(s, e, pre + text, s + pre.length + text.indexOf('\n') + 1);
        }
        return true;
      }
      case 'insertText':
        replaceRange(s, e, cmd.text);
        return true;
      case 'insertImage': {
        const t = `![${cmd.alt ?? ''}](${/\s/.test(cmd.src) ? `<${cmd.src}>` : cmd.src})`;
        replaceRange(s, e, t);
        return true;
      }
      case 'undo':
      case 'redo':
        ta.focus();
        return document.execCommand(cmd.kind);
      case 'selectAll':
        ta.focus();
        ta.select();
        return true;
      case 'find': {
        if (!cmd.query) return false;
        const hay = cmd.caseSensitive ? value : value.toLowerCase();
        const needle = cmd.caseSensitive ? cmd.query : cmd.query.toLowerCase();
        let at: number;
        if (cmd.backwards) {
          const from = (findFrom >= 0 ? Math.min(s, findFrom) : s) - 1;
          at = from >= 0 ? hay.lastIndexOf(needle, from) : -1;
          if (at < 0) at = hay.lastIndexOf(needle);
        } else {
          const from = value.slice(s, e).toLowerCase() === needle.toLowerCase() ? e : s;
          at = hay.indexOf(needle, from);
          if (at < 0) at = hay.indexOf(needle);
        }
        if (at < 0) return false;
        findFrom = at;
        ta.setSelectionRange(at, at + needle.length);
        scrollToLine(lineIndexAt(at));
        emitSel();
        return true;
      }
      case 'replace': {
        if (!cmd.query) return false;
        if (cmd.all) {
          if (!value.includes(cmd.query)) return false;
          replaceRange(0, value.length, value.split(cmd.query).join(cmd.replacement), s);
          return true;
        }
        if (value.slice(s, e) === cmd.query) {
          replaceRange(s, e, cmd.replacement, s + cmd.replacement.length);
        }
        return exec({ kind: 'find', query: cmd.query, caseSensitive: true });
      }
      // structural Paragraph/Format commands need the real core
      case 'headingLevel':
      case 'insertParagraph':
      case 'task':
      case 'clearFormat':
        return false;
    }
  };

  return {
    setMarkdown(md) {
      ta.value = md;
      ta.setSelectionRange(0, 0);
      autosize();
      requestAnimationFrame(autosize);
    },
    getMarkdown: () => ta.value,
    onChange(cb) {
      changeCbs.add(cb);
      return () => changeCbs.delete(cb);
    },
    onSelectionChange(cb) {
      selCbs.add(cb);
      return () => selCbs.delete(cb);
    },
    getOutline: () => outlineOf(ta.value),
    getActiveHeadingId() {
      const li = lineIndexAt(ta.selectionStart);
      let id: string | null = null;
      for (const hd of outlineOf(ta.value)) {
        if (Number(hd.id.slice(2)) <= li) id = hd.id;
        else break;
      }
      return id;
    },
    scrollToHeading(id) {
      const li = Number(id.replace(/^h-/, ''));
      if (!Number.isFinite(li)) return;
      const p = lineStart(li);
      ta.focus({ preventScroll: true });
      ta.setSelectionRange(p, p);
      scrollToLine(li);
      emitSel();
    },
    exec,
    getStats: () => countStats(ta.value),
    setSourceMode(on) {
      sourceMode = on;
      host.classList.toggle('stub-source', on);
    },
    isSourceMode: () => sourceMode,
    updateSettings(patch) {
      settings = { ...settings, ...patch };
      ta.spellcheck = settings.spellcheck;
      host.classList.toggle('stub-focus', settings.focusMode);
      host.classList.toggle('stub-typewriter', settings.typewriterMode);
    },
    renderHTML: () => miniMarkdownToHtml(ta.value, (s) => settings.resolveAsset(s)),
    focus: () => ta.focus(),
    destroy() {
      document.removeEventListener('selectionchange', onDocSel);
      ro.disconnect();
      ta.remove();
    },
  };
};
