import { describe, expect, it } from 'vitest';
import {
  escapeImageUrl,
  formatImageSrc,
  frontMatterValue,
  IMAGE_OPTION_DEFAULTS,
  imageSnippet,
  imageTarget,
  resolveWithRoot,
  rootDirOf,
  setFrontMatterValue,
  shouldApplyRule,
  type ImageOptions,
} from './rules';

const O = (p: Partial<ImageOptions> = {}): ImageOptions => ({ ...IMAGE_OPTION_DEFAULTS, ...p });
const assets = { kind: 'relative', dir: './assets' } as const;

describe('front matter', () => {
  it('reads scalar values with quotes and comments', () => {
    const md = '---\ntitle: x\ntypora-copy-images-to: "./${filename}.assets" # where\ntypora-root-url: ../site\n---\n\nbody\n';
    expect(frontMatterValue(md, 'typora-copy-images-to')).toBe('./${filename}.assets');
    expect(frontMatterValue(md, 'typora-root-url')).toBe('../site');
    expect(frontMatterValue(md, 'missing')).toBeNull();
    expect(frontMatterValue('no front matter\n---\na: b\n---\n', 'a')).toBeNull();
  });

  it('sets, replaces and removes keys losslessly', () => {
    expect(setFrontMatterValue('# T\n', 'typora-root-url', '../site')).toBe('---\ntypora-root-url: ../site\n---\n\n# T\n');
    const md = '---\ntitle: x\n---\n\n# T\n';
    const set = setFrontMatterValue(md, 'typora-root-url', '/a b');
    expect(set).toBe('---\ntitle: x\ntypora-root-url: "/a b"\n---\n\n# T\n');
    expect(setFrontMatterValue(set, 'typora-root-url', './x')).toBe('---\ntitle: x\ntypora-root-url: ./x\n---\n\n# T\n');
    expect(setFrontMatterValue(set, 'typora-root-url', null)).toBe(md);
    expect(setFrontMatterValue('a\r\n', 'k', 'v')).toBe('---\r\nk: v\r\n---\r\n\r\na\r\n');
  });
});

describe('imageTarget (front matter > preferences)', () => {
  it('front matter folder overrides the global rule', () => {
    const t = imageTarget({ markdown: '---\ntypora-copy-images-to: ./pics\n---\n', globalRule: assets, options: O() });
    expect(t).toEqual({ kind: 'copy', rule: { kind: 'relative', dir: './pics' }, source: 'yaml' });
    const abs = imageTarget({ markdown: '---\ntypora-copy-images-to: /var/img\n---\n', globalRule: assets, options: O() });
    expect(abs).toMatchObject({ kind: 'copy', rule: { kind: 'absolute', dir: '/var/img' } });
  });

  it('YAML upload needs the allow-upload option, else falls back with a warning', () => {
    const md = '---\ntypora-copy-images-to: upload\n---\n';
    expect(imageTarget({ markdown: md, globalRule: assets, options: O({ imageAllowYamlUpload: true }) })).toEqual({ kind: 'upload', source: 'yaml' });
    const t = imageTarget({ markdown: md, globalRule: assets, options: O() });
    expect(t.kind).toBe('copy');
    expect(t.warning).toContain('must be enabled first');
  });

  it('source mode ignores front matter; none = keep; upload preference', () => {
    const md = '---\ntypora-copy-images-to: ./pics\n---\n';
    expect(imageTarget({ markdown: md, globalRule: { kind: 'none' }, options: O(), sourceMode: true })).toEqual({ kind: 'keep' });
    expect(imageTarget({ markdown: '', globalRule: assets, options: O({ imageUploadOnInsert: true }) })).toEqual({ kind: 'upload', source: 'settings' });
  });

  it('scope toggles: local on, online off by default, data: never', () => {
    expect(shouldApplyRule(undefined, O())).toBe(true);
    expect(shouldApplyRule('/a.png', O())).toBe(true);
    expect(shouldApplyRule('/a.png', O({ imageApplyLocal: false }))).toBe(false);
    expect(shouldApplyRule('https://x/a.png', O())).toBe(false);
    expect(shouldApplyRule('ftp://x/a.png', O({ imageApplyOnline: true }))).toBe(true);
    expect(shouldApplyRule('data:image/png;base64,AA', O({ imageApplyOnline: true }))).toBe(false);
  });
});

describe('formatImageSrc (resolveImagePath)', () => {
  const doc = '/u/notes';
  it('relative by default, ./ prefix option, absolute when relative is off', () => {
    expect(formatImageSrc('/u/notes/assets/a b.png', { docDir: doc, rootDir: null, options: O() })).toBe('assets/a%20b.png');
    expect(formatImageSrc('/u/notes/assets/a.png', { docDir: doc, rootDir: null, options: O({ imageDotPrefix: true }) })).toBe('./assets/a.png');
    expect(formatImageSrc('/u/img/a.png', { docDir: doc, rootDir: null, options: O({ imageDotPrefix: true }) })).toBe('../img/a.png');
    expect(formatImageSrc('/u/notes/a.png', { docDir: doc, rootDir: null, options: O({ imageUseRelative: false }) })).toBe('/u/notes/a.png');
    expect(formatImageSrc('/u/notes/a b.png', { docDir: doc, rootDir: null, options: O({ imageAutoEscape: false }) })).toBe('a b.png');
  });

  it('typora-root-url writes site-root paths, falls back outside the root', () => {
    expect(formatImageSrc('/u/site/assets/a.png', { docDir: '/u/site/posts', rootDir: '/u/site', options: O() })).toBe('/assets/a.png');
    expect(formatImageSrc('/u/site/assets/a.png', { docDir: '/u/site/posts', rootDir: '/u/site', options: O({ imageDotPrefix: true }) })).toBe('./assets/a.png');
    expect(formatImageSrc('/other/a.png', { docDir: '/u/site/posts', rootDir: '/u/site', options: O() })).toBe('../../../other/a.png');
  });

  it('escapes characters that break destinations', () => {
    expect(escapeImageUrl("a #1 (x)'?.png")).toBe('a%20%231%20%28x%29%27%3F.png');
  });

  it('resolves root urls for rendering', () => {
    expect(rootDirOf('---\ntypora-root-url: ..\n---\n', '/u/site/posts')).toBe('/u/site');
    expect(rootDirOf('---\ntypora-root-url: /srv/www\n---\n', null)).toBe('/srv/www');
    expect(rootDirOf('# none\n', '/u')).toBeNull();
    expect(resolveWithRoot('/assets/a%20b.png', '/u/site')).toBe('/u/site/assets/a b.png');
    expect(resolveWithRoot('assets/a.png?v=1', '/u/site')).toBe('/u/site/assets/a.png');
    expect(resolveWithRoot('https://x/a.png', '/u/site')).toBeNull();
  });

  it('snippets in the preferred syntax', () => {
    expect(imageSnippet('assets/a.png', 'a [x]', 'markdown')).toBe('![a x](assets/a.png)');
    expect(imageSnippet('a b.png', 'a', 'markdown')).toBe('![a](<a b.png>)');
    expect(imageSnippet('assets/a.png', 'a', 'html')).toBe('<img src="assets/a.png" alt="a" />');
  });
});
