import type { EditorHandle } from '../../contracts';
import { draggedPath, dropMarkdown, endDrag } from './drag';

export interface DropHost {
  docDir(): string | null;
  editor(): EditorHandle;
}

function caretAt(x: number, y: number): Range | null {
  const d = document as Document & {
    caretPositionFromPoint?(x: number, y: number): { offsetNode: Node; offset: number } | null;
    caretRangeFromPoint?(x: number, y: number): Range | null;
  };
  const p = d.caretPositionFromPoint?.(x, y);
  if (p) {
    const r = document.createRange();
    r.setStart(p.offsetNode, p.offset);
    return r;
  }
  return d.caretRangeFromPoint?.(x, y) ?? null;
}

/**
 * Dropping a sidebar row on the document inserts a relative link to it (an image
 * reference for image files) at the drop point, as one undoable edit (#101).
 * Other drops (files from Finder, text) keep their default handling.
 */
export function installSidebarDrop(scroller: HTMLElement, host: DropHost): void {
  scroller.addEventListener(
    'dragover',
    (e) => {
      if (draggedPath(e) === null) return;
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
    },
    true,
  );
  scroller.addEventListener(
    'drop',
    (e) => {
      const path = draggedPath(e);
      if (path === null) return;
      e.preventDefault();
      e.stopPropagation();
      endDrag();
      if (!path) return;
      const ed = host.editor();
      const r = caretAt(e.clientX, e.clientY);
      ed.focus();
      if (r && scroller.contains(r.startContainer)) {
        const sel = window.getSelection();
        sel?.removeAllRanges();
        sel?.addRange(r);
        document.dispatchEvent(new Event('selectionchange'));
      }
      const md = dropMarkdown(path, host.docDir());
      ed.exec(md.image ? { kind: 'insertImage', src: md.src, alt: md.text.slice(2, md.text.indexOf(']')) } : { kind: 'insertText', text: md.text });
    },
    true,
  );
}
