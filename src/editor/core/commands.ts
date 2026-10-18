/** EditorCommand implementations (menus → exec) and undo/redo. */
import type { EditorCommand } from '../../contracts';
import type { EditorCore } from './editor';
import { leafContent, leafRaw, contPrefix } from './model';
import * as E from './edit';
import { splitBlockMeta } from './render-inline';
import { find, replace } from './find';
import { insertMarkdown } from './clipboard';
import { copyBlock } from './block-copy';
import { nextHeadingLevel, insertParagraph, taskStatus, clearFormat, insertFootnote } from './para-cmds';
import { selectScope, deleteScope, jumpTo } from './scopes';
import { copyAs, pastePlain } from './copy-as';
import { tableMarkdown, tableTool, codeTool, mathTool } from './block-tools';

export function undo(ed: EditorCore): boolean {
  const e = ed.hist.popUndo();
  if (!e) return false;
  ed.doc.replace(e.from, e.from + e.after.length, e.before);
  ed.view.sync();
  ed.setSel(e.selBefore ?? { pos: e.from });
  ed.emitChange();
  return true;
}

export function redo(ed: EditorCore): boolean {
  const e = ed.hist.popRedo();
  if (!e) return false;
  ed.doc.replace(e.from, e.from + e.before.length, e.after);
  ed.view.sync();
  ed.setSel(e.selAfter ?? { pos: e.from + e.after.length });
  ed.emitChange();
  return true;
}

const MARKS: Record<string, [string, string]> = {
  strong: ['**', '**'],
  em: ['*', '*'],
  code: ['`', '`'],
  strike: ['~~', '~~'],
  highlight: ['==', '=='],
  underline: ['<u>', '</u>'],
  sub: ['<sub>', '</sub>'],
  sup: ['<sup>', '</sup>'],
  math: ['$', '$'],
  comment: ['<!-- ', ' -->'],
};

function curLeaf(ed: EditorCore): number {
  if (!ed.doc.leaves.length) return -1;
  return ed.doc.locate(ed.sel().from).i;
}

function heading(ed: EditorCore, level: number): boolean {
  const i = curLeaf(ed);
  const l = ed.doc.leaves[i];
  if (!l || (l.type !== 'paragraph' && l.type !== 'heading')) return false;
  const c = leafContent(l);
  const off = ed.doc.locate(ed.sel().from).off;
  const [pre, body] = l.type === 'heading' ? splitBlockMeta(l, c) : ['', c];
  const text = l.setext ? body : c.slice(pre.length);
  const np = level ? '#'.repeat(level) + ' ' : '';
  ed.change(() => {
    ed.doc.setContent(i, np + text.replace(/\n/g, ' '));
    return { pos: ed.doc.docPos(i, np.length + Math.max(0, off - pre.length)) };
  });
  ed.hist.break();
  return true;
}

function mark(ed: EditorCore, m: string): boolean {
  const { from, to } = ed.sel();
  const a = ed.doc.locate(from);
  const b = ed.doc.locate(to);
  const l = ed.doc.leaves[a.i];
  if (!l || a.i !== b.i || !E.isTextLeaf(l)) return false;
  const c = leafContent(l);
  const [o, cl] = m === 'link' ? ['[', ']()'] : MARKS[m];
  const sel = c.slice(a.off, b.off);
  let next: string;
  let s0: number;
  let s1: number;
  if (c.slice(a.off - o.length, a.off) === o && c.slice(b.off, b.off + cl.length) === cl && m !== 'link') {
    next = c.slice(0, a.off - o.length) + sel + c.slice(b.off + cl.length);
    s0 = a.off - o.length;
    s1 = s0 + sel.length;
  } else if (sel.startsWith(o) && sel.endsWith(cl) && sel.length >= o.length + cl.length && m !== 'link') {
    next = c.slice(0, a.off) + sel.slice(o.length, sel.length - cl.length) + c.slice(b.off);
    s0 = a.off;
    s1 = b.off - o.length - cl.length;
  } else {
    next = c.slice(0, a.off) + o + sel + cl + c.slice(b.off);
    s0 = a.off + o.length;
    s1 = s0 + sel.length;
    if (m === 'link') s0 = s1 = s1 + 2;
  }
  ed.hist.break();
  ed.change(() => {
    ed.doc.setContent(a.i, next);
    return { anchor: ed.doc.docPos(a.i, s0), focus: ed.doc.docPos(a.i, s1) };
  });
  return true;
}

/** Toggle quote / list on the text leaves of the selection. */
function containerBlock(ed: EditorCore, kind: 'quote' | 'ul' | 'ol' | 'task'): boolean {
  const { from, to } = ed.sel();
  if (!ed.doc.leaves.length) return insertBlock(ed, kind === 'quote' ? '> ' : kind === 'ul' ? '- ' : kind === 'ol' ? '1. ' : '- [ ] ', false);
  const i0 = ed.doc.locate(from).i;
  const i1 = ed.doc.locate(to).i;
  const first = ed.doc.leaves[i0];
  const inner = first.chain[first.chain.length - 1];
  const has =
    inner &&
    (kind === 'quote'
      ? inner.kind === 'quote'
      : inner.kind === 'item' && (kind === 'task' ? inner.task !== null : inner.task === null && inner.ordered === (kind === 'ol')));
  ed.hist.break();
  const firstId = ed.doc.leaves[i0].id;
  const lastId = ed.doc.leaves[i1].id;
  ed.change(() => {
    let caret: E.Caret | undefined;
    for (let i = i1; i >= i0; i--) {
      const l = ed.doc.leaves[i];
      if (!E.isTextLeaf(l)) continue;
      if (has) {
        caret = E.dropContainer(ed.doc, i, 0);
        continue;
      }
      const n = i - i0 + 1;
      const mk = kind === 'quote' ? '> ' : kind === 'ul' ? '- ' : kind === 'ol' ? `${n}. ` : '- [ ] ';
      const cont = kind === 'quote' ? '> ' : ' '.repeat(kind === 'task' ? 2 : mk.length);
      const s = ed.doc.start(i);
      const lines = l.lines.map((ln, k) => ({ ...ln, prefix: ln.prefix + (k === 0 ? mk : k < l.n ? cont : '') }));
      ed.doc.replace(s, s + leafRaw(l).length, lines.map((x) => x.prefix + x.text + x.eol).join(''));
      caret = { pos: s + lines[0].prefix.length + leafContent(l).length };
    }
    // keep every touched block selected so the command can be toggled back
    const a = ed.doc.indexOf(firstId);
    const b = ed.doc.indexOf(lastId);
    if (i1 > i0 && a >= 0 && b >= a) return { anchor: ed.doc.docPos(a, 0), focus: ed.doc.docPos(b, leafContent(ed.doc.leaves[b]).length) };
    return caret;
  });
  ed.hist.break();
  return true;
}

/** Insert a block after the current leaf (or into it when it is an empty paragraph). */
/**
 * Insert Table (#98): like Typora, a top-level paragraph / heading is split at the caret
 * and the table goes between the halves (a selection is deleted first); otherwise the
 * table is inserted like any other block.
 */
function insertTableAtCaret(ed: EditorCore, md: string): boolean {
  const doc = ed.doc;
  let { from, to } = ed.sel();
  if (from !== to && doc.leaves.length) {
    ed.hist.break();
    ed.replaceRange(from, to, '', null);
    to = from;
  }
  if (!doc.leaves.length) return insertBlock(ed, md, true);
  const { i, off } = doc.locate(from);
  const l = doc.leaves[i];
  const len = l && E.isTextLeaf(l) ? leafContent(l).length : 0;
  if (!l || !(l.type === 'paragraph' || l.type === 'heading') || l.chain.length || off <= 0 || off >= len) return insertBlock(ed, md, true);
  const EOL = doc.eol;
  ed.hist.break();
  ed.change(() => {
    const at = doc.docPos(i, off);
    doc.replace(at, at, EOL + EOL + md + EOL + EOL);
    const nl = doc.leaves[doc.locate(at + 2 * EOL.length).i];
    return nl && !E.isTextLeaf(nl) ? { widget: nl.id, at: 'start' as const } : { pos: at };
  });
  ed.hist.break();
  return true;
}

function insertBlock(ed: EditorCore, md: string, focusWidget: boolean, caretOff?: number): boolean {
  const doc = ed.doc;
  const i = curLeaf(ed);
  const EOL = doc.eol;
  ed.hist.break();
  ed.change(() => {
    let at: number;
    const l = doc.leaves[i];
    if (!l) {
      doc.replace(0, 0, md);
      at = 0;
    } else if (E.isTextLeaf(l) && l.type === 'paragraph' && !leafContent(l).trim()) {
      at = doc.docPos(i, 0);
      doc.replace(at, doc.docPos(i, leafContent(l).length), md.split('\n').join(EOL + contPrefix(l.chain)));
    } else {
      const s = doc.start(i + 1);
      const t = doc.text();
      const pre = (s > 0 && !/[\n\r]$/.test(t.slice(0, s)) ? EOL : '') + (l.lines.length > l.n ? '' : EOL);
      const next = doc.leaves[i + 1];
      const post = next ? EOL + (next.type === 'paragraph' && !leafContent(next).trim() ? '' : EOL) : '';
      doc.replace(s, s, pre + md + post);
      at = s + pre.length;
    }
    const j = doc.locate(at).i;
    const nl = doc.leaves[j];
    if (focusWidget && nl && !E.isTextLeaf(nl)) return { widget: nl.id, at: 'start' as const };
    if (nl && E.isTextLeaf(nl) && nl.type !== 'hr') return { pos: doc.docPos(j, caretOff ?? leafContent(nl).length) };
    return E.ensureParagraphAfter(doc, j);
  });
  ed.hist.break();
  return true;
}

export function execCommand(ed: EditorCore, cmd: EditorCommand): boolean {
  switch (cmd.kind) {
    case 'heading':
      return heading(ed, cmd.level);
    case 'headingLevel': {
      const lv = nextHeadingLevel(ed, cmd.delta);
      return lv !== null && heading(ed, lv);
    }
    case 'mark':
      return mark(ed, cmd.mark);
    case 'insertParagraph':
      return insertParagraph(ed, cmd.where);
    case 'task':
      return taskStatus(ed, cmd.op);
    case 'clearFormat':
      return clearFormat(ed);
    case 'block':
      switch (cmd.block) {
        case 'quote':
        case 'ul':
        case 'ol':
        case 'task':
          return containerBlock(ed, cmd.block);
        case 'code':
          return insertBlock(ed, '```\n\n```', true);
        case 'math':
          return insertBlock(ed, '$$\n\n$$', true);
        case 'table':
          return insertBlock(ed, '|   |   |\n| --- | --- |\n|   |   |', true);
        case 'hr':
          return insertBlock(ed, '---', false);
        case 'toc':
          return insertBlock(ed, '[toc]', false);
        case 'html':
          return insertBlock(ed, '<div>\n</div>', true);
        case 'linkRef':
          return insertBlock(ed, '[]: ', false, 1);
        case 'footnote':
          return insertFootnote(ed);
        case 'front_matter': {
          const f = ed.doc.leaves[0];
          if (f?.type === 'front_matter') {
            ed.setSel({ widget: f.id, at: 'start' });
            return true;
          }
          ed.change(() => {
            const hasText = ed.doc.text().length > 0;
            ed.doc.replace(0, 0, '---' + ed.doc.eol + ed.doc.eol + '---' + ed.doc.eol + (hasText ? ed.doc.eol : ''));
            return { widget: ed.doc.leaves[0].id, at: 'start' };
          });
          return true;
        }
      }
      return false;
    case 'insertText':
      insertMarkdown(ed, cmd.text);
      return true;
    case 'insertImage':
      insertMarkdown(ed, `![${cmd.alt ?? ''}](${cmd.src.replace(/ /g, '%20')})`);
      return true;
    case 'undo':
      return undo(ed);
    case 'redo':
      return redo(ed);
    case 'selectAll': {
      ed.root.focus();
      const r = document.createRange();
      r.selectNodeContents(ed.root);
      getSelection()?.removeAllRanges();
      getSelection()?.addRange(r);
      return true;
    }
    case 'find':
      return find(ed, cmd.query, { caseSensitive: cmd.caseSensitive, wholeWord: cmd.wholeWord, regex: cmd.regex }, cmd.backwards);
    case 'replace':
      return replace(ed, cmd.query, cmd.replacement, cmd.all, { caseSensitive: cmd.caseSensitive, wholeWord: cmd.wholeWord, regex: cmd.regex });
    case 'select':
      return selectScope(ed, cmd.scope);
    case 'delete':
      return deleteScope(ed, cmd.scope);
    case 'jump':
      return jumpTo(ed, cmd.to);
    case 'copyAs':
      return copyAs(ed, cmd.format);
    case 'pastePlain':
      return pastePlain(ed);
    case 'copyBlock':
      return copyBlock(ed, cmd.part);
    case 'insertTable':
      return insertTableAtCaret(ed, tableMarkdown(cmd.rows, cmd.cols));
    case 'table':
      return tableTool(ed, cmd.op, { rows: cmd.rows, cols: cmd.cols });
    case 'code':
      return codeTool(ed, cmd.op);
    case 'math':
      return mathTool(ed, cmd.op);
  }
}
