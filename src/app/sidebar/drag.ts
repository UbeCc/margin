import { isImagePath, relativeFrom, stripExt, basename, isInside, dirname } from '../util/path';

/**
 * Drag & drop from the sidebar (#101, `typora.sidebar.drag`): rows carry the file
 * path under a private MIME type plus plain-text / uri-list fallbacks for other
 * apps; dropping on the editor inserts a link (or an image), dropping on a folder
 * row moves the item there.
 */
export const DRAG_MIME = 'application/x-margin-path';

/**
 * Path of the sidebar row being dragged in this window. Some engines (WebKitGTK)
 * drop custom MIME types from `dataTransfer.types`, so in-page drags are also
 * tracked here.
 */
let current: string | null = null;

/** Minimal platform surface `makeDraggable` needs (both sidebar hosts pass their host). */
export interface DragPlatform {
  startFileDrag?(paths: string[]): void;
}

const DRAG_THRESHOLD_PX = 4;

export function makeDraggable(row: HTMLElement, path: string, platform?: DragPlatform): void {
  row.draggable = true;
  row.addEventListener('dragend', () => (current = null));
  row.addEventListener('dragstart', (e) => {
    current = path;
    const dt = e.dataTransfer;
    if (!dt) return;
    dt.effectAllowed = 'copyMove';
    dt.setData(DRAG_MIME, path);
    dt.setData('text/plain', path);
    dt.setData('text/uri-list', 'file://' + encodeURI(path));
  });

  // Native drag-out (#129, Typora `controller.startDrag`): HTML5 drags cannot
  // leave the webview carrying a real file, so once a press on the row moves
  // past a few pixels we hand the gesture to the platform (it starts a native
  // drag from the live mouse event and the in-page dragstart never fires).
  // Platforms without `startFileDrag` (browser) keep the HTML5 drag above.
  if (!platform?.startFileDrag) return;
  row.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    const sx = e.clientX;
    const sy = e.clientY;
    const move = (ev: PointerEvent) => {
      if (Math.hypot(ev.clientX - sx, ev.clientY - sy) < DRAG_THRESHOLD_PX) return;
      cleanup();
      row.draggable = false; // suppress the HTML5 drag for this gesture
      const restore = () => {
        row.draggable = true;
        row.removeEventListener('dragend', restore);
        row.removeEventListener('pointerup', restore);
      };
      row.addEventListener('dragend', restore);
      row.addEventListener('pointerup', restore);
      platform.startFileDrag!([path]);
    };
    const cleanup = () => {
      row.removeEventListener('pointermove', move);
      row.removeEventListener('pointerup', cleanup);
    };
    row.addEventListener('pointermove', move);
    row.addEventListener('pointerup', cleanup);
  });
}

export function draggedPath(e: DragEvent): string | null {
  if (current) return current;
  const dt = e.dataTransfer;
  if (!dt || !Array.from(dt.types).includes(DRAG_MIME)) return null;
  return dt.getData(DRAG_MIME) || ''; // '' during dragover (data is protected until drop)
}

/** The drop consumed the drag (dragend may not fire after the source row re-renders). */
export function endDrag(): void {
  current = null;
}

/** Percent-encode what Markdown link destinations can't hold raw (spaces, parens, <>). */
export function encodeLinkPath(p: string): string {
  return p.replace(/[ ()<>]/g, (c) => encodeURIComponent(c));
}

/** Markdown inserted when `path` is dropped into a document living in `docDir` (null = untitled). */
export function dropMarkdown(path: string, docDir: string | null): { image: boolean; src: string; text: string } {
  const rel = docDir ? relativeFrom(docDir, path) : path;
  const src = encodeLinkPath(rel);
  const name = stripExt(basename(path));
  return isImagePath(path) ? { image: true, src, text: `![${name}](${src})` } : { image: false, src, text: `[${name}](${src})` };
}

/** May `src` be moved into folder `dest`? (not onto itself, its own parent or a descendant) */
export function canMoveInto(src: string, dest: string): boolean {
  return src !== dest && dirname(src) !== dest && !isInside(src, dest);
}
