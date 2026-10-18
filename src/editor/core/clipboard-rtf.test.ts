/** HTML → RTF generation for rich copy (#79). */
import { describe, it, expect } from 'vitest';
import { htmlToRtf, rtfEscape } from './clipboard-rtf';
import { Doc } from './model';
import { docHTML } from './html';

const ctx = { refs: new Map(), resolveAsset: (s: string) => s, inlineMath: null };
const rtfOf = (md: string) => htmlToRtf(docHTML(new Doc(md), ctx, () => null));

describe('rtfEscape', () => {
  it('escapes control chars and non-ASCII as signed \\uN?', () => {
    expect(rtfEscape('a\\b{c}')).toBe('a\\\\b\\{c\\}');
    expect(rtfEscape('é')).toBe('\\u233?');
    expect(rtfEscape('中')).toBe('\\u20013?');
    // U+1F600 → surrogate pair D83D DE00, both > 0x7fff → negative
    expect(rtfEscape('😀')).toBe('\\u-10179?\\u-8704?');
    expect(rtfEscape('a\tb\nc')).toBe('a\\tab b c');
  });
});

describe('htmlToRtf', () => {
  it('produces a well-formed document with balanced braces', () => {
    const r = rtfOf('# Title\n\nPara with **bold**, *it*, `code` and [link](https://x.org/a?b=1).\n');
    expect(r.startsWith('{\\rtf1\\ansi')).toBe(true);
    expect(r.endsWith('}')).toBe(true);
    let depth = 0;
    for (let i = 0; i < r.length; i++) {
      if (r[i] === '\\') i++;
      else if (r[i] === '{') depth++;
      else if (r[i] === '}') depth--;
      expect(depth).toBeGreaterThanOrEqual(0);
    }
    expect(depth).toBe(0);
  });
  it('headings, inline marks and links', () => {
    const r = rtfOf('## Head\n\nx **B** _I_ `c` ~~s~~ [L](https://e.com)\n');
    expect(r).toMatch(/\\b\\fs40 Head\\par/);
    expect(r).toContain('{\\b B}');
    expect(r).toContain('{\\i I}');
    expect(r).toContain('{\\f1 c}');
    expect(r).toContain('{\\strike s}');
    expect(r).toContain('HYPERLINK "https://e.com"');
    expect(r).toContain('{\\ul\\cf1 L}');
  });
  it('lists: bullets, numbers with start, nesting indents, tasks', () => {
    const r = rtfOf('3. one\n4. two\n   - inner\n\n- [x] done\n- [ ] todo\n');
    expect(r).toContain('3.\\tab one');
    expect(r).toContain('4.\\tab two');
    expect(r).toMatch(/\\li720\\fi-360\\sa60 \\u8226\?\\tab inner/);
    expect(r).toContain('\\u9745?\\tab done');
    expect(r).toContain('\\u9744?\\tab todo');
  });
  it('code blocks keep line breaks; quotes indent; unicode escaped', () => {
    const r = rtfOf('```\na {\n  b\n}\n```\n\n> café 中文\n');
    expect(r).toContain('a \\{\\line   b\\line \\}');
    expect(r).toMatch(/\\li360\\fi-0\\sa120 caf\\u233\? \\u20013\?\\u25991\?/);
  });
  it('tables become tab-separated rows; javascript: links are not emitted', () => {
    const r = htmlToRtf('<table><thead><tr><th>a</th><th>b</th></tr></thead><tbody><tr><td>1</td><td>2</td></tr></tbody></table>') + rtfOf('[x](javascript:alert(1))\n');
    expect(r).toMatch(/\\b a\\tab b\\par/);
    expect(r).toContain('1\\tab 2');
    expect(r).not.toContain('javascript');
  });
});
