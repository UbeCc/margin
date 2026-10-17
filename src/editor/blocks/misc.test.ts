import { describe, expect, it } from 'vitest';
import { isSafeUrl, sanitizeHtml, isInvisibleHtml } from './sanitize';
import { renderInlineMarkdown } from './inline-md';
import { flowToMermaid, sequenceToMermaid, toMermaid } from './diagram-translate';
import { yamlTopKeys } from './front-matter';
import { renderedToRawOffset } from './table';
import { tocHTML } from './toc';
import { renderTexSafe, inlineMathHTML } from './math';

describe('sanitizeHtml', () => {
  it('drops scripts, handlers and dangerous urls', () => {
    const out = sanitizeHtml('<div onclick="x()">hi<script>alert(1)</script><a href="javascript:alert(1)">l</a><img src=x onerror=alert(1)></div>');
    expect(out).toBe('<div>hi<a>l</a><img src="x"></div>');
  });
  it('keeps safe formatting and unwraps unknown tags', () => {
    expect(sanitizeHtml('<custom-el><b>x</b></custom-el><iframe src="https://e"></iframe>')).toBe('<b>x</b>');
    expect(sanitizeHtml('<p align="center" style="color:red;position:fixed">t</p>')).toBe('<p align="center" style="color:red">t</p>');
    expect(sanitizeHtml('<details open><summary>s</summary>b</details>')).toBe('<details open=""><summary>s</summary>b</details>');
  });
  it('resolves relative srcs', () => {
    expect(sanitizeHtml('<img src="a.png">', { resolveUrl: (u) => '/base/' + u })).toBe('<img src="/base/a.png">');
  });
  it('isSafeUrl', () => {
    expect(isSafeUrl('https://x')).toBe(true);
    expect(isSafeUrl('  JaVa\tscript:alert(1)')).toBe(false);
    expect(isSafeUrl('data:image/png;base64,AAA', 'src')).toBe(true);
    expect(isSafeUrl('data:text/html,<x>', 'href')).toBe(false);
    expect(isSafeUrl('img/a.png')).toBe(true);
  });
  it('detects invisible html', () => {
    expect(isInvisibleHtml('<!-- note -->')).toBe(true);
    expect(isInvisibleHtml('<br>')).toBe(true);
    expect(isInvisibleHtml('<img src="a">')).toBe(false);
  });
});

describe('renderInlineMarkdown', () => {
  it('renders common marks', () => {
    expect(renderInlineMarkdown('**b** *i* `c|d` ~~s~~ ==m==')).toBe('<strong>b</strong> <em>i</em> <code>c|d</code> <del>s</del> <mark>m</mark>');
    expect(renderInlineMarkdown('[t](http://a "T")')).toBe('<a href="http://a" title="T">t</a>');
    expect(renderInlineMarkdown('a\\|b <br> snake_case_var')).toBe('a|b <br> snake_case_var');
    expect(renderInlineMarkdown('<script>')).toBe('&lt;script&gt;');
    expect(renderInlineMarkdown('[x](javascript:alert(1))')).not.toContain('javascript');
  });
  it('math via callback', () => {
    expect(renderInlineMarkdown('$x$ costs $5', { renderMath: (t) => `[${t}]` })).toBe('[x] costs $5');
  });
});

describe('diagram translation', () => {
  it('sequence → mermaid', () => {
    const m = sequenceToMermaid('Title: T\nAlice->Bob: Hello\nNote right of Bob: thinks\nBob-->Alice: Hi');
    expect(m).toContain('sequenceDiagram');
    expect(m).toContain('Alice->>Bob: Hello');
    expect(m).toContain('Note right of Bob: thinks');
    expect(m).toContain('Bob-->>Alice: Hi');
  });
  it('flow → mermaid', () => {
    const m = flowToMermaid('st=>start: Start\nop=>operation: Do it\ncond=>condition: OK?\ne=>end\nst->op->cond\ncond(yes)->e\ncond(no, right)->op');
    expect(m).toContain('st(["Start"])');
    expect(m).toContain('cond{"OK?"}');
    expect(m).toContain('st --> op');
    expect(m).toContain('cond -->|yes| e');
    expect(m).toContain('cond -->|no| op');
  });
  it('mermaid passes through', () => {
    expect(toMermaid('mermaid', 'graph TD\nA-->B')).toBe('graph TD\nA-->B');
  });
});

describe('misc helpers', () => {
  it('yamlTopKeys', () => {
    expect(yamlTopKeys('title: x\ntags:\n  - a\n"quoted key": 1\n# c')).toEqual(['title', 'tags', 'quoted key']);
  });
  it('renderedToRawOffset skips markers', () => {
    expect(renderedToRawOffset('**ab**c', 2)).toBe(4);
    expect(renderedToRawOffset('abc', 10)).toBe(3);
  });
  it('tocHTML nests by level', () => {
    const html = tocHTML([
      { id: 'h1', level: 2, text: 'A <b>' },
      { id: 'h2', level: 3, text: 'B' },
    ]);
    expect(html).toContain('--toc-depth:0');
    expect(html).toContain('--toc-depth:1');
    expect(html).toContain('A &lt;b&gt;');
    expect(html).toContain('data-heading-id="h2"');
  });
  it('katex render + errors', () => {
    expect(renderTexSafe('x^2', true).html).toContain('katex');
    const bad = renderTexSafe('\\frac{', true);
    expect(bad.error).toBeTruthy();
    expect(inlineMathHTML('\\badcmd{')).toContain('mb-math-error');
  });
});
