/**
 * Global registry filled by `editor/blocks` (via `installBlocks(api)`) or by
 * the app: block widgets, the inline-math renderer, the source-mode factory
 * and fence routing (lang → widget type). The core never imports blocks.
 */
import type { BlockWidget, EditorSettings, RenderInlineMath, WidgetBlockType } from '../../contracts';

/** Structural copy of blocks' SourceModeInstance (no runtime import). */
export interface SourceModeLike {
  getMarkdown(): string;
  setMarkdown(md: string): void;
  focus(): void;
  destroy(): void;
  updateSettings?(s: EditorSettings): void;
  find?(q: string, opts?: { caseSensitive?: boolean; backwards?: boolean; wholeWord?: boolean; regexp?: boolean }): boolean;
  replace?(q: string, replacement: string, opts?: { caseSensitive?: boolean; all?: boolean; wholeWord?: boolean; regexp?: boolean }): boolean;
  undo?(): boolean;
  redo?(): boolean;
  /** Optional caret / scroll hand-off (#35): 0-based line at the viewport top, scroll a line to the top. */
  getTopLine?(): number;
  scrollToLine?(line: number): void;
  /** Main selection as markdown offsets (feature-detected). */
  getSelection?(): { anchor: number; head: number };
  setSelection?(anchor: number, head: number): void;
  /** CodeMirror escape hatch (blocks' source mode): used for the selection when the methods above are absent. */
  readonly view?: {
    state: { selection: { main: { anchor: number; head: number } } };
    dispatch(tr: { selection: { anchor: number; head?: number }; scrollIntoView?: boolean }): void;
  };
}

export type SourceModeFactoryLike = (
  host: HTMLElement,
  opts: { markdown: string; settings: EditorSettings; onChange(markdown: string): void; onSelectionChange?(): void },
) => SourceModeLike;

/** Route a fenced block by its info-string language; return null for the default. */
export type FenceRouter = (lang: string) => WidgetBlockType | null;

export const registry = {
  widgets: new Map<WidgetBlockType, BlockWidget>(),
  inlineMath: null as RenderInlineMath | null,
  sourceMode: null as SourceModeFactoryLike | null,
  fenceRouters: [] as FenceRouter[],
};

const DIAGRAM_LANGS = new Set(['mermaid', 'sequence', 'flow', 'flowchart']);

export function registerWidget(w: BlockWidget): void {
  registry.widgets.set(w.type, w);
}

export function registerInlineMath(fn: RenderInlineMath): void {
  registry.inlineMath = fn;
}

export function registerSourceMode(factory: SourceModeFactoryLike): void {
  registry.sourceMode = factory;
}

export function registerFenceRouter(fn: FenceRouter): void {
  registry.fenceRouters.unshift(fn);
}

/** Widget type for a fence language. Default: diagram langs → 'diagram' once that widget exists. */
export function routeFence(lang: string | undefined): WidgetBlockType {
  const l = (lang || '').toLowerCase();
  for (const r of registry.fenceRouters) {
    const t = r(l);
    if (t) return t;
  }
  if (DIAGRAM_LANGS.has(l) && registry.widgets.has('diagram')) return 'diagram';
  return 'code_fence';
}
