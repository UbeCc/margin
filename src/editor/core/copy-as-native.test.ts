/**
 * #115/#116 wiring: baseUrl for the rich-copy payload, the native payload
 * fallback when the engine refuses execCommand, and Copy as / Paste as in
 * source mode.
 */
import { describe, it, expect } from 'vitest';
import type { NativeClipboardData } from '../../contracts';
import type { EditorCore } from './editor';
import type { SourceModeLike } from './registry';
import { copyAsInSourceMode, pastePlainInSourceMode, writePayload, lastCopyAs } from './copy-as';
import { MARGIN_MIME } from './clipboard-flavors';

const fakeEd = (settings: Record<string, unknown>): EditorCore => ({ settings } as unknown as EditorCore);

describe('writePayload native fallback (#116)', () => {
  // jsdom: no execCommand, no navigator.clipboard → every web path is refused.
  it('maps the payload flavours onto the native write', async () => {
    const calls: NativeClipboardData[] = [];
    const ok = await writePayload(
      { 'text/plain': 'p', 'text/html': '<b>h</b>', 'text/rtf': '{\\rtf1}', [MARGIN_MIME]: '# md' },
      {
        writeClipboardNative: (d) => (calls.push(d), Promise.resolve(true)),
        docUrl: 'file:///a%20b.md',
      },
    );
    expect(ok).toBe(true);
    expect(calls).toEqual([{ plain: 'p', html: '<b>h</b>', rtf: '{\\rtf1}', markdown: '# md', baseUrl: 'file:///a%20b.md' }]);
  });

  it('omits absent flavours and resolves false without a native writer', async () => {
    const calls: NativeClipboardData[] = [];
    await writePayload({ 'text/plain': 'only' }, { writeClipboardNative: (d) => (calls.push(d), Promise.resolve(false)) });
    expect(calls).toEqual([{ plain: 'only' }]);
    await expect(writePayload({ 'text/plain': 'x' })).resolves.toBe(false);
  });

  it('a native rejection (not a refusal) resolves false instead of throwing', async () => {
    await expect(writePayload({ 'text/plain': 'x' }, { writeClipboardNative: () => Promise.reject(new Error('gone')) })).resolves.toBe(false);
  });
});

type Src = SourceModeLike & { _md: string; replaced: string[] };

const source = (md: string, anchor: number, head: number): Src => {
  const s = {
    _md: md,
    replaced: [] as string[],
    getMarkdown: () => s._md,
    getSelection: () => ({ anchor, head }),
    replaceSelection: (text: string) => {
      s._md = s._md.slice(0, Math.min(anchor, head)) + text + s._md.slice(Math.max(anchor, head));
      s.replaced.push(text);
    },
  };
  return s as Src;
};

describe('Copy as … in source mode (#116, fe-contextmenus §1.5)', () => {
  it('every variant copies the selected source text', () => {
    expect(copyAsInSourceMode(ed, source('# Head\n\nbody **bold**\n', 8, 12))).toBe(true);
    expect(lastCopyAs.get(ed)).toEqual({ 'text/plain': 'body' });
  });

  it('backward selections and the CodeMirror view fallback resolve the same range', () => {
    const ed = fakeEd({});
    expect(copyAsInSourceMode(ed, source('abcdef', 5, 1))).toBe(true);
    expect(lastCopyAs.get(ed)).toEqual({ 'text/plain': 'bcde' });
    const view = {
      getMarkdown: () => 'xyz',
      view: { state: { selection: { main: { anchor: 0, head: 2 } } } },
    } as unknown as SourceModeLike;
    expect(copyAsInSourceMode(ed, view)).toBe(true);
    expect(lastCopyAs.get(ed)).toEqual({ 'text/plain': 'xy' });
  });

  it('a collapsed selection copies nothing and reports false', () => {
    expect(copyAsInSourceMode(fakeEd({}), source('abc', 1, 1))).toBe(false);
  });
});

describe('Paste as Plain Text in source mode (#116)', () => {
  it('reads the pasteboard plain flavour and replaces the selection (CRLF normalised)', async () => {
    const clip = Promise.resolve({ plain: 'a\r\nb', html: '<p>ignored</p>', rtfHtml: null });
    const ed = fakeEd({ readClipboard: () => clip });
    const s = source('one two', 4, 7);
    expect(pastePlainInSourceMode(ed, s)).toBe(true);
    await clip; // the helper awaited this promise first, so its continuation is queued ahead
    expect(s._md).toBe('one a\nb');
  });

  it('falls back to the web clipboard; does nothing when both are empty', async () => {
    const ed = fakeEd({ readClipboard: () => Promise.resolve(null) });
    const s = source('keep', 0, 0);
    expect(pastePlainInSourceMode(ed, s)).toBe(true);
    await Promise.resolve(); // jsdom has no navigator.clipboard → both reads come back empty
    await Promise.resolve();
    await Promise.resolve();
    expect(s._md).toBe('keep');
  });

  it('reports false when the source mode cannot replace', () => {
    expect(pastePlainInSourceMode(fakeEd({}), { getMarkdown: () => '' })).toBe(false);
  });
});
