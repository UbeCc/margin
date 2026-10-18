/** Diagram (mermaid SVG) export helpers for the context menu (#97): Save Diagram As… / Copy as Image. */

/** Standalone SVG document text for a rendered `<svg>` element. */
export function svgSource(svg: SVGElement): string {
  const c = svg.cloneNode(true) as SVGElement;
  if (!c.getAttribute('xmlns')) c.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
  if (!c.getAttribute('xmlns:xlink')) c.setAttribute('xmlns:xlink', 'http://www.w3.org/1999/xlink');
  const r = svg.getBoundingClientRect();
  if (!c.getAttribute('width') && r.width) c.setAttribute('width', String(Math.ceil(r.width)));
  if (!c.getAttribute('height') && r.height) c.setAttribute('height', String(Math.ceil(r.height)));
  return '<?xml version="1.0" encoding="UTF-8"?>\n' + new XMLSerializer().serializeToString(c);
}

/** Rasterize `svg` (2× for crispness) and put it on the clipboard as PNG. */
export async function copySvgAsPng(svg: SVGElement): Promise<boolean> {
  try {
    const r = svg.getBoundingClientRect();
    const url = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svgSource(svg));
    const img = new Image();
    img.src = url;
    await img.decode();
    const scale = 2;
    const c = document.createElement('canvas');
    c.width = Math.max(1, Math.ceil((r.width || img.naturalWidth) * scale));
    c.height = Math.max(1, Math.ceil((r.height || img.naturalHeight) * scale));
    const g = c.getContext('2d')!;
    g.fillStyle = '#fff';
    g.fillRect(0, 0, c.width, c.height);
    g.drawImage(img, 0, 0, c.width, c.height);
    const png = await new Promise<Blob>((res, rej) => c.toBlob((b) => (b ? res(b) : rej(new Error('toBlob'))), 'image/png'));
    await navigator.clipboard.write([new ClipboardItem({ 'image/png': png })]);
    return true;
  } catch {
    return false;
  }
}
