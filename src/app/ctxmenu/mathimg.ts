import type { Platform } from '../../contracts';
import { renderTex } from '../../editor/blocks/math';
import { extras } from '../platform-extras';

/**
 * KaTeX → PNG rasterizer (#138): "Save Math As…" and inline "Copy as Image".
 *
 * KaTeX renders to HTML spans, so the markup is wrapped in an SVG
 * `foreignObject` with the KaTeX stylesheet (fonts inlined as data URLs — an
 * SVG decoded through an <img> loads no external resources) and rasterized at
 * 2× onto a white canvas.
 */
import ams from 'katex/dist/fonts/KaTeX_AMS-Regular.woff2?url';
import caligraphic from 'katex/dist/fonts/KaTeX_Caligraphic-Regular.woff2?url';
import caligraphicBold from 'katex/dist/fonts/KaTeX_Caligraphic-Bold.woff2?url';
import fraktur from 'katex/dist/fonts/KaTeX_Fraktur-Regular.woff2?url';
import frakturBold from 'katex/dist/fonts/KaTeX_Fraktur-Bold.woff2?url';
import main from 'katex/dist/fonts/KaTeX_Main-Regular.woff2?url';
import mainBold from 'katex/dist/fonts/KaTeX_Main-Bold.woff2?url';
import mainBoldItalic from 'katex/dist/fonts/KaTeX_Main-BoldItalic.woff2?url';
import math from 'katex/dist/fonts/KaTeX_Math-Italic.woff2?url';
import sansItalic from 'katex/dist/fonts/KaTeX_SansSerif-Italic.woff2?url';
import sans from 'katex/dist/fonts/KaTeX_SansSerif-Regular.woff2?url';
import mainItalic from 'katex/dist/fonts/KaTeX_Main-Italic.woff2?url';
import script from 'katex/dist/fonts/KaTeX_Script-Regular.woff2?url';
import mathBold from 'katex/dist/fonts/KaTeX_Math-BoldItalic.woff2?url';
import sansBold from 'katex/dist/fonts/KaTeX_SansSerif-Bold.woff2?url';
import sansBoldItalic from 'katex/dist/fonts/KaTeX_SansSerif-Bold.woff2?url'; // KaTeX ships no SansSerif-BoldItalic; Bold is the closest
import size1 from 'katex/dist/fonts/KaTeX_Size1-Regular.woff2?url';
import size2 from 'katex/dist/fonts/KaTeX_Size2-Regular.woff2?url';
import size3 from 'katex/dist/fonts/KaTeX_Size3-Regular.woff2?url';
import size4 from 'katex/dist/fonts/KaTeX_Size4-Regular.woff2?url';
import typewriter from 'katex/dist/fonts/KaTeX_Typewriter-Regular.woff2?url';

/** Font family file → bundled asset URL (the names used by `url(fonts/…)` in katex.min.css). */
const FONT_URLS: Record<string, string> = {
  'KaTeX_AMS-Regular': ams,
  'KaTeX_Caligraphic-Regular': caligraphic,
  'KaTeX_Caligraphic-Bold': caligraphicBold,
  'KaTeX_Fraktur-Regular': fraktur,
  'KaTeX_Fraktur-Bold': frakturBold,
  'KaTeX_Main-Regular': main,
  'KaTeX_Main-Bold': mainBold,
  'KaTeX_Main-Italic': mainItalic,
  'KaTeX_Main-BoldItalic': mainBoldItalic,
  'KaTeX_Math-Italic': math,
  'KaTeX_Math-BoldItalic': mathBold,
  'KaTeX_SansSerif-Regular': sans,
  'KaTeX_SansSerif-Bold': sansBold,
  'KaTeX_SansSerif-Italic': sansItalic,
  'KaTeX_SansSerif-BoldItalic': sansBoldItalic, // katex.min.css may synthesize it; KaTeX ships no such file, Bold stands in
  'KaTeX_Script-Regular': script,
  'KaTeX_Size1-Regular': size1,
  'KaTeX_Size2-Regular': size2,
  'KaTeX_Size3-Regular': size3,
  'KaTeX_Size4-Regular': size4,
  'KaTeX_Typewriter-Regular': typewriter,
};

let cssCache: string | null = null;

/** KaTeX stylesheet with every `url(fonts/…)` replaced by a data URL (woff2 only, fetched once). */
async function inlinedKatexCss(): Promise<string> {
  if (cssCache) return cssCache;
  // Dynamic like export.ts `loadKatexCss()`: the 23 KB stylesheet loads only when math is exported.
  const mod = (await import('katex/dist/katex.min.css?raw')) as { default: string };
  const data: Record<string, string> = {};
  for (const [name, url] of Object.entries(FONT_URLS)) {
    const buf = await (await fetch(url)).arrayBuffer();
    data[name] = `url(data:font/woff2;base64,${toBase64(buf)})`;
  }
  cssCache = mod.default
    // woff2 source of each @font-face → data URL; drop the woff/ttf fallbacks.
    .replace(/url\((['"]?)fonts\/([^)'"]+)\.woff2\1\)/g, (_m, _q, name: string) => `url(${data[name] ?? 'data:,'})`)
    .replace(/,\s*url\((['"]?)fonts\/[^)'"]+\.(?:woff|ttf)\1\)(\s+format\(['"](?:woff|truetype)['"]\))?/g, '');
  return cssCache;
}

function toBase64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

/** Rasterize a rendered `.katex` element (2×, white background) as PNG bytes. */
export async function katexPng(el: Element): Promise<Uint8Array | null> {
  try {
    const css = await inlinedKatexCss();
    const r = el.getBoundingClientRect();
    const clone = el.cloneNode(true) as Element;
    const w = Math.max(1, Math.ceil(r.width));
    const h = Math.max(1, Math.ceil(r.height));
    const svg =
      `<?xml version="1.0" encoding="UTF-8"?>\n` +
      `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">` +
      `<foreignObject width="100%" height="100%"><div xmlns="http://www.w3.org/1999/xhtml">` +
      `<style>${css}</style>${new XMLSerializer().serializeToString(clone)}</div></foreignObject></svg>`;
    const img = new Image();
    img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
    await img.decode();
    const scale = 2;
    const c = document.createElement('canvas');
    c.width = Math.max(1, Math.ceil((r.width || img.naturalWidth) * scale));
    c.height = Math.max(1, Math.ceil((r.height || img.naturalHeight) * scale));
    const g = c.getContext('2d')!;
    g.fillStyle = '#fff';
    g.fillRect(0, 0, c.width, c.height);
    g.drawImage(img, 0, 0, c.width, c.height);
    const blob = await new Promise<Blob>((res, rej) => c.toBlob((b) => (b ? res(b) : rej(new Error('toBlob'))), 'image/png'));
    return new Uint8Array(await blob.arrayBuffer());
  } catch {
    return null;
  }
}

/** Rasterize TeX source: rendered offscreen with KaTeX, then PNG bytes (#138, shared with `math:copyImage`). */
export async function rasterizeMathPng(tex: string, display: boolean): Promise<Uint8Array | null> {
  const holder = document.createElement('div');
  holder.style.cssText = 'position:fixed;left:-99999px;top:0;';
  holder.innerHTML = renderTex(tex, display);
  document.body.append(holder);
  try {
    return await katexPng(holder.firstElementChild!);
  } finally {
    holder.remove();
  }
}

/** "Save Math As…": rasterize the rendered math and write it through the platform's binary export. */
export async function saveMathAs(platform: Platform, el: Element): Promise<void> {
  const bytes = await katexPng(el);
  if (!bytes) throw new Error('rasterization failed');
  const out = await platform.saveFileDialog({ defaultPath: 'math.png', filters: [{ name: 'PNG', extensions: ['png'] }] });
  if (out) await extras(platform).exportBinary!(bytes, out);
}

/** Inline-math "Copy as Image" (#138): PNG bytes onto the clipboard. */
export async function copyMathAsImage(el: Element): Promise<boolean> {
  const bytes = await katexPng(el);
  if (!bytes) return false;
  try {
    const blob = new Blob([bytes as BlobPart], { type: 'image/png' });
    await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
    return true;
  } catch {
    return false;
  }
}
