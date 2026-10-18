/**
 * Copy Math ▸ Copy as Image (#127): rasterize TeX through KaTeX and put a
 * transparent PNG on the clipboard. Reuses the Export ▸ Image pipeline
 * (`rasterizeHtml`) with a minimal page that pulls in the KaTeX stylesheet
 * (`loadKatexCss`, fonts from CDN), so fidelity matches image export.
 */
import { renderTex } from '../editor/blocks';
import { loadKatexCss } from './export';
import { rasterizeHtml } from './export-image';

let cssCache: Promise<string> | null = null;
const katexCss = (): Promise<string> => (cssCache ??= loadKatexCss());

/**
 * Standalone page for one formula: transparent body, no margins, display math
 * centered on its own line, inline math inline-sized.
 */
export function mathImagePage(html: string, css: string, display: boolean): string {
  const body = display ? `<div class="m">${html}</div>` : `<span class="m">${html}</span>`;
  return [
    '<!DOCTYPE html><html><head><meta charset="utf-8">',
    `<style>${css}</style>`,
    '<style>html,body{margin:0;padding:8px;background:transparent;font-size:24px}',
    '.m{display:inline-block;line-height:1.2;white-space:nowrap}div.m{display:block;text-align:left}</style>',
    `</head><body>${body}</body></html>`,
  ].join('');
}

/** Render `tex` and write it to the clipboard as a PNG. Resolves false on failure. */
export async function copyMathAsImage(tex: string, display: boolean): Promise<boolean> {
  try {
    const css = await katexCss();
    const { bytes } = await rasterizeHtml(mathImagePage(renderTex(tex, display), css, display), {
      width: 800,
      format: 'png',
      quality: 'best',
    });
    await navigator.clipboard.write([new ClipboardItem({ 'image/png': new Blob([bytes.buffer as ArrayBuffer], { type: 'image/png' }) })]);
    return true;
  } catch {
    return false;
  }
}
