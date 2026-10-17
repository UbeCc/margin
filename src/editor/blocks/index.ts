/**
 * Margin block widgets: public entry point.
 *
 *   import { installBlocks } from './editor/blocks';
 *   installBlocks({ registerWidget, registerInlineMath, registerSourceMode });
 *
 * See README.md in this directory for the integration contract.
 */
import 'katex/dist/katex.min.css';
import './blocks.css';
import type { BlockWidget, RenderInlineMath } from '../../contracts';
import { createCodeFenceWidget, CodeFenceOptions } from './code-fence';
import { createMathBlockWidget, MathOptions, renderInlineMath } from './math';
import { createDiagramWidget } from './diagram';
import { createTableWidget } from './table';
import { createHtmlBlockWidget } from './html-block';
import { createFrontMatterWidget } from './front-matter';
import { createTocWidget } from './toc';
import { createSourceMode, SourceModeFactory } from './source-mode';

export interface BlocksApi {
  registerWidget(widget: BlockWidget): void;
  registerInlineMath(fn: RenderInlineMath): void;
  registerSourceMode(factory: SourceModeFactory): void;
}

export interface BlocksOptions {
  code?: CodeFenceOptions;
  math?: MathOptions;
}

/** All widgets, in registration order. */
export function createWidgets(opts: BlocksOptions = {}): BlockWidget[] {
  return [
    createCodeFenceWidget(opts.code),
    createMathBlockWidget(opts.math),
    createDiagramWidget(),
    createTableWidget(),
    createHtmlBlockWidget(),
    createFrontMatterWidget(),
    createTocWidget(),
  ];
}

/** Register every widget, the inline-math renderer and the source-mode factory with the core. */
export function installBlocks(api: BlocksApi, opts: BlocksOptions = {}): void {
  for (const w of createWidgets(opts)) api.registerWidget(w);
  api.registerInlineMath(renderInlineMath);
  api.registerSourceMode(createSourceMode);
}

export { renderInlineMath, inlineMathHTML, renderTex } from './math';
export { createSourceMode } from './source-mode';
export type { SourceModeFactory, SourceModeInstance, SourceModeOptions, SourceModeFindOptions } from './source-mode';
export { createCodeFenceWidget, staticCodeHTML } from './code-fence';
export { createMathBlockWidget } from './math';
export { createDiagramWidget, renderDiagram } from './diagram';
export { isDiagramLang, toMermaid } from './diagram-translate';
export { createTableWidget } from './table';
export { createHtmlBlockWidget } from './html-block';
export { createFrontMatterWidget } from './front-matter';
export { createTocWidget, tocHTML, OUTLINE_CHANGED_EVENT } from './toc';
export { sanitizeHtml } from './sanitize';
export { renderInlineMarkdown } from './inline-md';
export { parseTable, formatTable, serializeTable, emptyTable } from './table-model';
export { parseFence, makeFence, fenceLang } from './util/delimited';
export { loadLanguage } from './cm/setup';
export { default as blocksCSS } from './blocks.css?inline';
