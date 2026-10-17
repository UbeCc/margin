/**
 * Fallback widget for block types without a registered BlockWidget: an
 * editable `<pre>` over the block's raw source.
 */
import type { BlockWidget, WidgetBlockType } from '../../contracts';
import { readText } from './dom';

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

export function fallbackWidget(type: WidgetBlockType): BlockWidget {
  return {
    type,
    mount(host, ctx) {
      const pre = document.createElement('pre');
      pre.className = 'md-fallback';
      pre.contentEditable = 'true';
      pre.spellcheck = false;
      pre.textContent = ctx.raw;
      host.append(pre);
      let raw = ctx.raw;
      const stop = (e: Event) => e.stopPropagation();
      for (const t of ['beforeinput', 'paste', 'cut', 'copy', 'compositionstart', 'compositionend']) pre.addEventListener(t, stop);
      pre.addEventListener('input', (e) => {
        e.stopPropagation();
        raw = readText(pre);
        if (raw.trim() === '') ctx.onRemove();
        else ctx.onChange(raw);
      });
      pre.addEventListener('keydown', (e) => {
        if (e.metaKey || e.ctrlKey || e.altKey) return;
        e.stopPropagation();
        const sel = getSelection();
        if (e.key === 'Enter') {
          e.preventDefault();
          document.execCommand('insertText', false, '\n');
        } else if (e.key === 'Escape') ctx.onExit('down');
        else if (sel && sel.isCollapsed && (e.key === 'ArrowUp' || e.key === 'ArrowLeft')) {
          const r = sel.getRangeAt(0).cloneRange();
          r.setStart(pre, 0);
          if (!r.toString().length) {
            e.preventDefault();
            ctx.onExit(e.key === 'ArrowUp' ? 'up' : 'left');
          }
        } else if (sel && sel.isCollapsed && (e.key === 'ArrowDown' || e.key === 'ArrowRight')) {
          const r = sel.getRangeAt(0).cloneRange();
          r.setEnd(pre, pre.childNodes.length);
          if (!r.toString().replace(/\n$/, '').length) {
            e.preventDefault();
            ctx.onExit(e.key === 'ArrowDown' ? 'down' : 'right');
          }
        }
      });
      return {
        update(r) {
          if (r !== raw) {
            raw = r;
            pre.textContent = r;
          }
        },
        focus(at) {
          pre.focus();
          const r = document.createRange();
          r.selectNodeContents(pre);
          r.collapse(at === 'start');
          const s = getSelection();
          s?.removeAllRanges();
          s?.addRange(r);
        },
        renderHTML: () => `<pre class="md-fallback"><code>${esc(raw)}</code></pre>`,
        destroy() {
          pre.remove();
        },
      };
    },
  };
}
