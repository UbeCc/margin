import { describe, expect, it } from 'vitest';
import { fakeEditor } from './upload-fakes';
import { applyUrls, findImageRefs, localImages, uploadConfig, uploadSettingsOf, withSrc, UPLOAD_DEFAULTS } from '../upload';

describe('upload settings', () => {
  it('defaults and validation', () => {
    expect(uploadSettingsOf({})).toEqual(UPLOAD_DEFAULTS);
    expect(uploadSettingsOf({ uploader: 'picgo', picgoPort: '8080', uploadTimeout: 999 })).toMatchObject({ uploader: 'picgo', picgoPort: 8080, uploadTimeout: 30 });
    expect(uploadSettingsOf({ uploader: 'bogus', picgoPort: 0 })).toMatchObject({ uploader: 'none', picgoPort: 36677 });
  });
  it('native config or an actionable message', () => {
    expect(typeof uploadConfig(uploadSettingsOf({}))).toBe('string');
    expect(typeof uploadConfig(uploadSettingsOf({ uploader: 'command', uploadCommand: '  ' }))).toBe('string');
    expect(uploadConfig(uploadSettingsOf({ uploader: 'command', uploadCommand: ' picgo upload ', uploadTimeout: 5 }))).toEqual({ kind: 'command', command: 'picgo upload', timeoutSecs: 5 });
    expect(uploadConfig(uploadSettingsOf({ uploader: 'picgo', picgoPort: 1234 }))).toEqual({ kind: 'picgo', port: 1234, timeoutSecs: 30 });
  });
});

describe('findImageRefs', () => {
  it('markdown and html images with titles, angle brackets, offsets', () => {
    const md = 'a ![x](assets/a.png "t") b\n![](<my pic.png>)\n<img alt="z" src="c.jpg">\n';
    const refs = findImageRefs(md);
    expect(refs.map((r) => r.src)).toEqual(['assets/a.png', 'my pic.png', 'c.jpg']);
    for (const r of refs) {
      expect(md.slice(r.index, r.index + r.raw.length)).toBe(r.raw);
      expect(r.raw.slice(r.srcOffset, r.srcOffset + r.src.length)).toBe(r.src);
    }
    expect(withSrc(refs[0], 'https://u/1')).toBe('![x](https://u/1 "t")');
    expect(withSrc(refs[1], 'https://u/2')).toBe('![](<https://u/2>)');
  });
  it('ignores code fences and inline code', () => {
    const md = '```\n![a](in-fence.png)\n```\n`![b](inline.png)` ![c](real.png)\n~~~md\n![d](x.png)\n~~~\n';
    expect(findImageRefs(md).map((r) => r.src)).toEqual(['real.png']);
  });
  it('localImages resolves against the doc dir and skips URLs / duplicates', () => {
    const refs = findImageRefs('![](a%20b.png) ![](https://x/y.png) ![](a%20b.png) ![](/abs/c.png) ![](data:image/png;base64,AA)');
    expect(localImages(refs, '/docs')).toEqual([
      { src: 'a%20b.png', path: '/docs/a b.png' },
      { src: '/abs/c.png', path: '/abs/c.png' },
    ]);
    expect(localImages(findImageRefs('![](rel.png)'), null)).toEqual([]);
  });
});

describe('applyUrls', () => {
  it('rewrites every reference through the editor (undoable replace)', () => {
    const ed = fakeEditor('![a](p.png) text p.png ![b](p.png "t") ![c](q.png)');
    expect(applyUrls(ed, new Map([['p.png', 'https://cdn/p']]))).toEqual([]);
    expect(ed.getMarkdown()).toBe('![a](https://cdn/p) text p.png ![b](https://cdn/p "t") ![c](q.png)');
    expect(ed.calls.every((c) => c.kind === 'replace')).toBe(true);
  });
  it('refuses when a case-insensitive replace would hit another image', () => {
    const ed = fakeEditor('![](A.png) ![](a.png)');
    expect(applyUrls(ed, new Map([['a.png', 'https://cdn/a']]))).toEqual(['a.png']);
    expect(ed.getMarkdown()).toBe('![](A.png) ![](a.png)');
  });
});
