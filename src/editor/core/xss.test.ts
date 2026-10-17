/** Export / copy HTML must not carry script vectors from the markdown source (#41). */
import { describe, it, expect } from 'vitest';
import { Doc } from './model';
import { docHTML } from './html';

const html = (md: string) => docHTML(new Doc(md), { refs: new Map(), resolveAsset: (s) => s, inlineMath: null }, () => null);

describe('docHTML sanitizes inline HTML and URLs (#41)', () => {
  it('drops event handlers and javascript: urls in inline HTML', () => {
    const out = html('a <img src=x onerror="window.__pwned=1"> b <a href="javascript:x">l</a> c\n');
    expect(out).not.toMatch(/onerror|javascript:/i);
    expect(out).toContain('<img src="x">');
    expect(out).toContain('>l</a>');
  });
  it('drops script / iframe / svg onload in headings and footnotes', () => {
    for (const md of ['# t <script>alert(1)</script>\n', 'x <iframe src="//e"></iframe> <svg onload=alert(1)></svg>\n', '[^1]: f <b onclick=x>b</b>\n\nr[^1]\n']) {
      const out = html(md);
      expect(out, md).not.toMatch(/<script|<iframe|onload|onclick|alert\(1\)<\/script/i);
    }
  });
  it('neutralises obfuscated / non-js dangerous link schemes and image data documents', () => {
    expect(html('[m](&#106;avascript:alert(1))\n')).not.toMatch(/href="javascript/i);
    for (const md of ['[m](JaVaScRiPt:alert(1))\n', '[m](vbscript:x)\n', '[m](data:text/html,<script>x</script>)\n']) {
      expect(html(md), md).toContain('href="#"');
    }
    expect(html('![i](javascript:x)\n')).not.toContain('javascript');
  });
  it('keeps harmless inline HTML and markdown formatting', () => {
    const out = html('x <kbd>Ctrl</kbd> **b** <span style="color:red">r</span> [l](https://e.com)\n');
    expect(out).toContain('<kbd>Ctrl</kbd>');
    expect(out).toContain('<strong>b</strong>');
    expect(out).toContain('href="https://e.com"');
  });
});
