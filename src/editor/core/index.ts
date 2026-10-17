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
  return {
    getMarkdown: () => ta.value,
    setMarkdown: (md) => void (ta.value = md),
    focus: () => ta.focus(),
    destroy: () => ta.remove(),
  };
}

export function createEditor(host: HTMLElement, settings: EditorSettings): EditorHandle {
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
    ed.root.hidden = true;
    source = { inst, el };
    inst.focus();
  };
  const sourceOff = () => {
    if (!source) return;
    const md = source.inst.getMarkdown();
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
        if (cmd.kind === 'find') return s.find?.(cmd.query, { caseSensitive: cmd.caseSensitive, backwards: cmd.backwards }) ?? false;
        if (cmd.kind === 'replace') return s.replace?.(cmd.query, cmd.replacement, { all: cmd.all }) ?? false;
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
      Object.assign(ed.settings, patch);
      ed.applyModes();
      ed.view.updateSettings(ed.settings);
      source?.inst.updateSettings?.(ed.settings);
      if (assets) ed.view.sync(true);
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
