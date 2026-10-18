import { describe, expect, it } from 'vitest';
import { sentenceRange, styledRange, wordRange } from './scopes';
import { htmlToPlain, plainFromClipboard, wordHtml } from './copy-as';

const sl = (t: string, r: [number, number] | null) => (r ? t.slice(r[0], r[1]) : null);

describe('scopes (#96)', () => {
  it('wordRange picks the word under or just before the caret, skipping markers', () => {
    const t = 'say **hello** world';
    expect(sl(t, wordRange(t, 7))).toBe('hello');
    expect(sl(t, wordRange(t, 13 - 2))).toBe('hello');
    expect(sl(t, wordRange(t, 3))).toBe('say'); // at the end of "say"
    expect(sl(t, wordRange(t, 19))).toBe('world');
    expect(wordRange('a  b', 2)).toBeNull(); // between spaces
    expect(sl("don't stop", wordRange("don't stop", 1))).toBe("don't");
    expect(sl('well-known x', wordRange('well-known x', 2))).toBe('well-known');
  });

  it('sentenceRange stays inside one line and excludes surrounding spaces', () => {
    const t = 'One two. Three four! Five?\nNext line here.';
    expect(sl(t, sentenceRange(t, 2))).toBe('One two.');
    expect(sl(t, sentenceRange(t, 12))).toBe('Three four!');
    expect(sl(t, sentenceRange(t, 23))).toBe('Five?');
    expect(sl(t, sentenceRange(t, 30))).toBe('Next line here.');
    expect(sl('no stop here', sentenceRange('no stop here', 4))).toBe('no stop here');
    expect(sl('中文第一句。第二句。', sentenceRange('中文第一句。第二句。', 7))).toBe('第二句。');
  });

  it('styledRange finds the innermost styled run (inner text / outer with markers)', () => {
    const t = 'a **bold *both* x** `code` [link](u) ~~s~~ ==h==';
    const at = (s: string) => t.indexOf(s) + 1;
    const r = styledRange(t, at('both'))!;
    expect(t.slice(...r.inner)).toBe('both');
    expect(t.slice(...r.outer)).toBe('*both*');
    expect(t.slice(...styledRange(t, at('x**'))!.inner)).toBe('bold *both* x');
    expect(t.slice(...styledRange(t, at('code'))!.outer)).toBe('`code`');
    expect(t.slice(...styledRange(t, at('link'))!.inner)).toBe('link');
    expect(t.slice(...styledRange(t, at('link'))!.outer)).toBe('[link](u)');
    expect(t.slice(...styledRange(t, t.indexOf('~~s') + 2)!.inner)).toBe('s');
    expect(t.slice(...styledRange(t, t.indexOf('==h') + 2)!.inner)).toBe('h');
    expect(styledRange(t, 0)).toBeNull(); // plain "a"
  });
});

describe('copy-as helpers (#96)', () => {
  it('htmlToPlain renders blocks on lines, cells with tabs, no markup', () => {
    const html = '<h1>T</h1><p>a <strong>b</strong></p><ul><li>one</li><li>two</li></ul><table><tr><th>x</th><th>y</th></tr><tr><td>1</td><td>2</td></tr></table><pre><code>k = 1\nj</code></pre>';
    expect(htmlToPlain(html)).toBe('T\n\na b\n\none\ntwo\n\nx\ty\n1\t2\n\nk = 1\nj');
  });

  it('wordHtml inlines styles and marks the document for Office', () => {
    const w = wordHtml('<h2>H</h2><p>x</p>');
    expect(w).toContain('content="Word.Document"');
    expect(w).toMatch(/<h2 style="font-size:18pt[^"]*">H<\/h2>/);
  });

  it('plainFromClipboard strips Margin formatting, keeps foreign plain text', () => {
    const margin = { 'text/html': '<div data-margin-md="**b**"><p><strong>b</strong></p></div>', 'text/plain': '**b**', 'text/x-margin-markdown': '**b**' } as Record<string, string>;
    expect(plainFromClipboard((t) => margin[t] ?? '')).toBe('b');
    const web = { 'text/html': '<p><em>hi</em></p>', 'text/plain': 'hi there' } as Record<string, string>;
    expect(plainFromClipboard((t) => web[t] ?? '')).toBe('hi there');
    expect(plainFromClipboard((t) => (t === 'text/html' ? '<p>only <b>html</b></p>' : ''))).toBe('only html');
  });
});

describe('find options (#96)', () => {
  it('whole word, regex and case options', async () => {
    const { findMatch, compileQuery } = await import('./query');
    const t = 'cat concat Cat cat_x cat.';
    expect(findMatch(t, 'cat', 0, 0)?.index).toBe(0);
    expect(findMatch(t, 'cat', 0, 3)?.index).toBe(7); // inside "concat"
    expect(findMatch(t, 'cat', 0, 3, { wholeWord: true })?.index).toBe(11); // "Cat"
    expect(findMatch(t, 'cat', 0, 3, { wholeWord: true, caseSensitive: true })?.index).toBe(21); // "cat." (cat_x is one word)
    expect(findMatch(t, 'c[a-z]+t', 0, 3, { regex: true })?.length).toBe(6); // "concat"
    expect(findMatch(t, 'cat', 5, 5, {}, true)?.index).toBe(0);
    expect(compileQuery('(', { regex: true })).toBeNull(); // invalid pattern: no match, no throw
    expect(findMatch(t, '(', 0, 0, { regex: true })).toBeNull();
    expect(findMatch(t, 'a*', 0, 0, { regex: true })?.length).toBe(1); // empty matches skipped
  });

  it('regex replacement expands groups', async () => {
    const { expandReplacement } = await import('./find');
    const m = /(?<y>\d{4})-(\d\d)/.exec('2026-10')!;
    expect(expandReplacement('$2/$<y> [$&] $$ $9', m)).toBe('10/2026 [2026-10] $ $9');
  });
});
