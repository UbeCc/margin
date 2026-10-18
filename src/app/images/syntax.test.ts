import { describe, expect, it } from 'vitest';
import { parseImage, setZoom, switchSyntax, zoomChoices, zoomOf } from './syntax';

describe('image syntax', () => {
  it('parses markdown and html images', () => {
    expect(parseImage('![a \\] b](<x y.png> "T")')).toEqual({ html: false, src: 'x y.png', alt: 'a ] b', title: 'T', attrs: [] });
    expect(parseImage('<img src="a.png" alt="A" style="zoom:50%;"/>')).toEqual({ html: true, src: 'a.png', alt: 'A', title: null, attrs: [['style', 'zoom:50%;']] });
    expect(parseImage('<img alt="no src">')).toBeNull();
    expect(parseImage('not an image')).toBeNull();
  });

  it('switches syntax both ways (zoom dropped on markdown)', () => {
    expect(switchSyntax('![shot](assets/a.png "t")', 'html')).toBe('<img src="assets/a.png" alt="shot" title="t" />');
    expect(switchSyntax('<img src="a b.png" alt="x" style="zoom:50%;" />', 'markdown')).toBe('![x](<a b.png>)');
    expect(switchSyntax('![a](a.png)', 'markdown')).toBe('![a](a.png)');
  });

  it('zooms: markdown becomes html, 100% removes zoom, other styles kept', () => {
    const z = setZoom('![a](a.png)', '50%');
    expect(z).toBe('<img src="a.png" alt="a" style="zoom:50%;" />');
    expect(zoomOf(z)).toBe('50%');
    expect(setZoom(z, '100%')).toBe('<img src="a.png" alt="a" />');
    expect(setZoom('<img src="a.png" style="border:0; zoom:33%">', '200%')).toBe('<img src="a.png" alt="" style="zoom:200%;border:0;" />');
    expect(setZoom('![a](a.png)', '100%')).toBe('![a](a.png)');
  });

  it('offers 1/scale for hi-dpi images', () => {
    expect(zoomChoices(2)[0]).toBe('50%');
    expect(zoomChoices(1.25)).toContain('80%');
    expect(zoomChoices(3)[0]).toBe('33%');
    expect(zoomChoices(1.5)[0]).toBe('67%');
    expect(zoomChoices(4)[0]).toBe('25%');
    expect(zoomChoices(null)).toEqual(['25%', '33%', '50%', '67%', '80%', '100%', '150%', '200%']);
    expect(zoomChoices(1.25)[0]).toBe('80%');
  });
});
