/**
 * Margin editing core — public entry.
 *
 *   import { createEditor, registerWidget, registerInlineMath, registerSourceMode } from './editor/core';
 *   installBlocks({ registerWidget, registerInlineMath, registerSourceMode });   // editor/blocks
 *   const ed = createEditor(host, settings);
 */
import './editor.css';
import type { EditorHandle, EditorSettings } from '../../contracts';
import { EditorCore, OUTLINE_EVENT } from './editor';
import { attachInput } from './input';
import { execCommand } from './commands';
import { docHTML } from './html';
import { countStats, plainText } from './query';
import { registry, type SourceModeLike } from './registry';
import { isTextLeaf } from './edit';
import { setSyntaxOptions } from './parser/options';

export { registerWidget, registerInlineMath, registerSourceMode, registerFenceRouter } from './registry';
export type { FenceRouter, SourceModeFactoryLike, SourceModeLike } from './registry';
export { OUTLINE_EVENT };

/** Textarea used for source mode when no factory is registered. */
function textareaSource(host: HTMLElement, opts: { markdown: string; onChange(md: string): void }): SourceModeLike {
  const ta = document.createElement('textarea');
  ta.className = 'md-source-fallback';
  ta.spellcheck = false;
  ta.value = opts.markdown;
  ta.addEventListener('input', () => opts.onChange(ta.value));
  host.append(ta);
  const lh = () => parseFloat(getComputedStyle(ta).lineHeight) || 20;
  return {
    getMarkdown: () => ta.value,
    setMarkdown: (md) => void (ta.value = md),
    getSelection: () => (ta.selectionDirection === 'backward' ? { anchor: ta.selectionEnd, head: ta.selectionStart } : { anchor: ta.selectionStart, head: ta.selectionEnd }),
    setSelection: (a, h) => ta.setSelectionRange(Math.min(a, h), Math.max(a, h), h < a ? 'backward' : 'forward'),
    getTopLine: () => Math.floor(ta.scrollTop / lh()),
    scrollToLine: (line) => void (ta.scrollTop = line * lh()),
    focus: () => ta.focus(),
    destroy: () => ta.remove(),
  };
}

const lineOf = (text: string, pos: number) => {
  let n = 0;
  for (let i = text.indexOf('\n'); i >= 0 && i < pos; i = text.indexOf('\n', i + 1)) n++;
  return n;
};
const offsetOfLine = (text: string, line: number) => {
  let p = 0;
  for (let k = 0; k < line; k++) {
    const i = text.indexOf('\n', p);
    if (i < 0) return text.length;
    p = i + 1;
  }
  return p;
};

export function createEditor(host: HTMLElement, settings: EditorSettings): EditorHandle {
  setSyntaxOptions(settings.markdown);
  const ed = new EditorCore(host, { ...settings });
  const detach = attachInput(ed);
  let source: { inst: SourceModeLike; el: HTMLElement } | null = null;
  ed.view.sync();

  const sourceOn = () => {
    const el = document.createElement('div');
    el.className = 'md-source-host';
    host.append(el);
    const opts = {
      markdown: ed.doc.text(),
      settings: ed.settings,
      onChange: () => ed.emitChange(),
      onSelectionChange: () => ed.emitSel(),
    };
    let inst: SourceModeLike;
    try {
      inst = registry.sourceMode ? registry.sourceMode(el, opts) : textareaSource(el, opts);
    } catch (e) {
      console.error('[margin] source mode failed, using textarea', e);
      el.textContent = '';
      inst = textareaSource(el, opts);
    }
    const sel = ed.readSel() ?? ed.lastSel ?? { anchor: 0, focus: 0 };
    const top = topLeafLine();
    ed.root.hidden = true;
    source = { inst, el };
    inst.focus();
    // carry caret and scroll position into source mode (#35)
    try {
      if (top !== null) inst.scrollToLine?.(top);
      if (inst.setSelection) inst.setSelection(sel.anchor, sel.focus);
      else inst.view?.dispatch({ selection: { anchor: sel.anchor, head: sel.focus }, scrollIntoView: top === null });
    } catch (e) {
      console.error('[margin] source mode caret hand-off failed', e);
    }
  };

  /** 0-based source line of the first text block visible in the viewport (null when unknown / at the top). */
  const topLeafLine = (): number | null => {
    const r = ed.root.getBoundingClientRect();
    const sc = scrollBox();
    const limit = Math.max(r.top, sc ? sc.getBoundingClientRect().top : 0);
    if (r.top >= limit) return null;
    for (const l of ed.doc.leaves) {
      const el = ed.view.recs.get(l.id)?.el;
      if (el && el.getBoundingClientRect().bottom > limit) return lineOf(ed.doc.text(), ed.doc.start(ed.doc.indexOf(l.id)));
    }
    return null;
  };
  const scrollBox = (): HTMLElement | null => {
    for (let p = host as HTMLElement | null; p; p = p.parentElement) {
      const o = getComputedStyle(p).overflowY;
      if ((o === 'auto' || o === 'scroll') && p.scrollHeight > p.clientHeight) return p;
    }
    return null;
  };
  const sourceOff = () => {
    if (!source) return;
    const md = source.inst.getMarkdown();
    let sel: { anchor: number; head: number } | null = null;
    let top: number | null = null;
    try {
      const m = source.inst.view?.state.selection.main; // CodeMirror SelectionRange: anchor/head are getters
      sel = source.inst.getSelection?.() ?? (m ? { anchor: m.anchor, head: m.head } : null);
      top = source.inst.getTopLine?.() ?? null;
    } catch {
      /* hand-off is best effort */
    }
    source.inst.destroy();
    source.el.remove();
    source = null;
    ed.root.hidden = false;
    if (md !== ed.doc.text()) {
      ed.hist.break();
      ed.change(() => {
        ed.doc.reparse(md);
      });
      ed.hist.break();
    }
    ed.view.sync();
    // carry caret and scroll position back (#35)
    if (top !== null && top > 0) {
      const pos = offsetOfLine(md, top);
      const leaf = ed.doc.leaves[ed.doc.locate(pos).i];
      ed.view.recs.get(leaf?.id ?? '')?.el.scrollIntoView({ block: 'start' });
    }
    if (sel) {
      const fit = (p: number) => {
        const at = ed.doc.locate(Math.max(0, Math.min(p, md.length)));
        return ed.doc.docPos(at.i, at.off);
      };
      ed.root.focus({ preventScroll: true });
      ed.setSel({ anchor: fit(sel.anchor), focus: fit(sel.head) }, top === null);
    }
  };

  const handle: EditorHandle = {
    setMarkdown(md) {
      if (source) source.inst.setMarkdown(md);
      ed.doc.set(md);
      ed.hist.clear();
      ed.lastSel = null;
      ed.view.sync();
      document.dispatchEvent(new CustomEvent(OUTLINE_EVENT));
    },
    getMarkdown: () => (source ? source.inst.getMarkdown() : ed.doc.text()),
    onChange(cb) {
      ed.changeCbs.add(cb);
      return () => ed.changeCbs.delete(cb);
    },
    onSelectionChange(cb) {
      ed.selCbs.add(cb);
      return () => ed.selCbs.delete(cb);
    },
    getOutline: () => ed.outline(),
    getActiveHeadingId() {
      const s = ed.readSel() ?? ed.lastSel;
      if (!s || !ed.doc.leaves.length) return null;
      for (let i = ed.doc.locate(s.focus).i; i >= 0; i--) if (ed.doc.leaves[i].type === 'heading') return ed.doc.leaves[i].id;
      return null;
    },
    scrollToHeading: (id) => ed.scrollToHeading(id),
    exec(cmd) {
      if (source) {
        const s = source.inst;
        if (cmd.kind === 'find')
          return s.find?.(cmd.query, { caseSensitive: cmd.caseSensitive, backwards: cmd.backwards, wholeWord: cmd.wholeWord, regexp: cmd.regex }) ?? false;
        if (cmd.kind === 'replace')
          return s.replace?.(cmd.query, cmd.replacement, { all: cmd.all, caseSensitive: cmd.caseSensitive, wholeWord: cmd.wholeWord, regexp: cmd.regex }) ?? false;
        if (cmd.kind === 'undo') return s.undo?.() ?? false;
        if (cmd.kind === 'redo') return s.redo?.() ?? false;
        return false;
      }
      try {
        return execCommand(ed, cmd);
      } catch (e) {
        console.error('[margin] exec failed', cmd, e);
        return false;
      }
    },
    getStats() {
      if (source) ed.doc.reparse(source.inst.getMarkdown());
      return countStats(plainText(ed.doc), ed.doc.text());
    },
    setSourceMode(on) {
      if (on && !source) sourceOn();
      else if (!on && source) sourceOff();
    },
    isSourceMode: () => !!source,
    updateSettings(patch) {
      const assets = 'resolveAsset' in patch || 'baseDir' in patch;
      if (patch.markdown) patch = { ...patch, markdown: { ...ed.settings.markdown, ...patch.markdown } };
      // #102: parser-relevant syntax options re-parse the (unchanged) source and re-render everything.
      const reparse = setSyntaxOptions(patch.markdown);
      Object.assign(ed.settings, patch);
      ed.applyModes();
      ed.view.updateSettings(ed.settings);
      source?.inst.updateSettings?.(ed.settings);
      if (reparse && !source) {
        const focused = ed.root.contains(document.activeElement);
        const sel = ed.readSel() ?? ed.lastSel;
        ed.doc.reparse(ed.doc.text());
        ed.view.sync(true);
        if (sel && focused) ed.setSel(sel, false);
      } else if (assets) ed.view.sync(true);
    },
    renderHTML() {
      if (source) {
        ed.doc.reparse(source.inst.getMarkdown());
        ed.view.sync();
      }
      return docHTML(ed.doc, ed.view.inlineCtx(), (l) => {
        if (isTextLeaf(l)) return null;
        try {
          return ed.view.widget(l.id)?.renderHTML() ?? null;
        } catch {
          return null;
        }
      });
    },
    focus() {
      if (source) return source.inst.focus();
      ed.root.focus({ preventScroll: true });
      ed.setSel(ed.lastSel ?? { pos: 0 }, false);
    },
    destroy() {
      detach();
      source?.inst.destroy();
      source?.el.remove();
      ed.view.destroy();
      ed.root.remove();
      ed.changeCbs.clear();
      ed.selCbs.clear();
    },
  };
  return handle;
}

export default createEditor;
