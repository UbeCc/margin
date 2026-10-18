/**
 * Export › Image (#95, `typora.export.image`): rasterize a standalone export HTML
 * page to PNG / JPEG entirely in the webview (no native snapshot API needed, so it
 * works the same in Tauri and the browser build).
 *
 * Pipeline: offscreen iframe at the target width → wait for layout + images →
 * inline every <img> as a data: URL → serialize to XHTML inside an SVG
 * <foreignObject> → draw onto a canvas → encode.
 */

export type ImageFormat = 'png' | 'jpeg';
/** Typora-style quality presets: Medium / High / Best (Best = 2× pixels). */
export type ImageQuality = 'medium' | 'high' | 'best';

export interface RasterOptions {
  width: number;
  format: ImageFormat;
  quality: ImageQuality;
  /** Page background painted under the content (JPEG has no alpha). */
  background?: string;
}

export interface RasterResult {
  bytes: Uint8Array;
  width: number;
  height: number;
}

/** Hard limits: beyond these canvases silently fail (WebKit) or exhaust memory. */
export const MAX_IMAGE_SIDE = 32_000;
export const MAX_IMAGE_PIXELS = 100_000_000;

export class ImageTooLargeError extends Error {
  constructor(public readonly width: number, public readonly height: number) {
    super(`Generated image too large (${width}×${height} px). Reduce the image width or export as PDF instead.`);
    this.name = 'ImageTooLargeError';
  }
}

export function qualitySettings(q: ImageQuality): { scale: number; jpeg: number } {
  if (q === 'best') return { scale: 2, jpeg: 1 };
  if (q === 'high') return { scale: 1, jpeg: 0.92 };
  return { scale: 1, jpeg: 0.6 };
}

/** Check pixel dimensions against the canvas limits (throws ImageTooLargeError). */
export function checkImageSize(width: number, height: number): void {
  if (width > MAX_IMAGE_SIDE || height > MAX_IMAGE_SIDE || width * height > MAX_IMAGE_PIXELS) {
    throw new ImageTooLargeError(width, height);
  }
}

/** Format implied by an output path; defaults to PNG. */
export function imageFormatForPath(path: string): ImageFormat {
  return /\.jpe?g$/i.test(path) ? 'jpeg' : 'png';
}

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result));
    r.onerror = () => reject(r.error);
    r.readAsDataURL(blob);
  });
}

async function inlineImages(doc: Document): Promise<void> {
  const imgs = [...doc.querySelectorAll('img')];
  await Promise.all(
    imgs.map(async (img) => {
      const src = img.currentSrc || img.src;
      if (!src || src.startsWith('data:')) return;
      try {
        const res = await fetch(src);
        if (!res.ok) throw new Error(String(res.status));
        img.src = await blobToDataUrl(await res.blob());
        img.removeAttribute('srcset');
      } catch {
        // Unreachable / cross-origin image: drop it rather than tainting the canvas.
        img.removeAttribute('src');
        img.removeAttribute('srcset');
      }
    }),
  );
}

function waitImages(doc: Document, timeoutMs: number): Promise<void> {
  const pending = [...doc.images].filter((i) => !i.complete);
  if (!pending.length) return Promise.resolve();
  return new Promise((resolve) => {
    let left = pending.length;
    const done = (): void => {
      if (--left <= 0) resolve();
    };
    for (const i of pending) {
      i.addEventListener('load', done, { once: true });
      i.addEventListener('error', done, { once: true });
    }
    setTimeout(resolve, timeoutMs);
  });
}

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.decoding = 'sync';
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('Could not render the document as an image'));
    img.src = url;
  });
}

function canvasToBytes(canvas: HTMLCanvasElement, type: string, quality: number): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (b) => {
        if (!b) return reject(new Error('Image encoding failed'));
        void b.arrayBuffer().then((buf) => resolve(new Uint8Array(buf)), reject);
      },
      type,
      quality,
    );
  });
}

/** Render `html` (a complete export page) to image bytes. */
export async function rasterizeHtml(html: string, opts: RasterOptions): Promise<RasterResult> {
  const width = Math.max(200, Math.min(4000, Math.round(opts.width)));
  const frame = document.createElement('iframe');
  frame.setAttribute('aria-hidden', 'true');
  frame.style.cssText = `position:fixed;left:-${width + 1000}px;top:0;width:${width}px;height:10px;border:0;visibility:hidden;`;
  document.body.appendChild(frame);
  try {
    await new Promise<void>((resolve) => {
      frame.addEventListener('load', () => resolve(), { once: true });
      frame.srcdoc = html;
    });
    const doc = frame.contentDocument!;
    await waitImages(doc, 5000);
    await (doc as Document & { fonts?: FontFaceSet }).fonts?.ready;
    await inlineImages(doc);
    // Scripts would not run inside an SVG image anyway; drop them to keep it inert.
    for (const s of doc.querySelectorAll('script')) s.remove();
    const height = Math.max(doc.documentElement.scrollHeight, doc.body?.scrollHeight ?? 0, 1);
    const { scale, jpeg } = qualitySettings(opts.quality);
    const pw = Math.round(width * scale);
    const ph = Math.round(height * scale);
    checkImageSize(pw, ph);

    doc.documentElement.style.width = `${width}px`;
    const xhtml = new XMLSerializer().serializeToString(doc.documentElement);
    const svg =
      `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">` +
      `<foreignObject x="0" y="0" width="100%" height="100%">${xhtml}</foreignObject></svg>`;
    const img = await loadImage(`data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`);

    const canvas = document.createElement('canvas');
    canvas.width = pw;
    canvas.height = ph;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new ImageTooLargeError(pw, ph);
    const bg = opts.background ?? getComputedStyle(doc.body).backgroundColor;
    ctx.fillStyle = !bg || bg === 'rgba(0, 0, 0, 0)' || bg === 'transparent' ? '#ffffff' : bg;
    if (opts.format === 'jpeg' || bg) ctx.fillRect(0, 0, pw, ph);
    ctx.scale(scale, scale);
    ctx.drawImage(img, 0, 0, width, height);
    const bytes = await canvasToBytes(canvas, opts.format === 'jpeg' ? 'image/jpeg' : 'image/png', jpeg);
    return { bytes, width: pw, height: ph };
  } finally {
    frame.remove();
  }
}

/** Width/height of a PNG or JPEG byte stream (for tests and sanity checks). */
export function imageDimensions(b: Uint8Array): { format: ImageFormat; width: number; height: number } | null {
  if (b.length > 24 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) {
    const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
    return { format: 'png', width: dv.getUint32(16), height: dv.getUint32(20) };
  }
  if (b.length > 4 && b[0] === 0xff && b[1] === 0xd8) {
    let i = 2;
    while (i + 9 < b.length) {
      if (b[i] !== 0xff) return null;
      const marker = b[i + 1];
      const len = (b[i + 2] << 8) | b[i + 3];
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return { format: 'jpeg', height: (b[i + 5] << 8) | b[i + 6], width: (b[i + 7] << 8) | b[i + 8] };
      }
      i += 2 + len;
    }
  }
  return null;
}
