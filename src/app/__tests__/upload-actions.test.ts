import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Platform, UploadConfig } from '../../contracts';
import { ImageUploader, imageSrcAt, type UploadHost } from '../upload-actions';
import { uploadPrefsSection } from '../upload-prefs';
import { closeContextMenu } from '../ui/contextmenu';
import { fakeEditor } from './upload-fakes';

const DOC = '# t\n\n![one](assets/a.png) and ![two](<b c.png>) ![web](https://x/y.png)\n';

function setup(opts: { md?: string; upload?: (paths: string[], c: UploadConfig) => Promise<string[]>; settings?: object; baseDir?: string | null } = {}) {
  const editor = fakeEditor(opts.md ?? DOC);
  const notes: [string, string][] = [];
  const uploadImages = opts.upload ? vi.fn(opts.upload) : undefined;
  const platform = { kind: 'tauri', uploadImages } as unknown as Platform;
  const host: UploadHost = {
    platform,
    editor: () => editor,
    baseDir: () => (opts.baseDir === undefined ? '/docs' : opts.baseDir),
    settings: () => opts.settings ?? { uploader: 'command', uploadCommand: "'/opt/my up' -u", uploadTimeout: 7 },
    notify: (m, k) => void notes.push([k, m]),
  };
  return { editor, notes, uploadImages, uploader: new ImageUploader(host) };
}

afterEach(() => {
  closeContextMenu();
  document.body.replaceChildren();
});

describe('ImageUploader', () => {
  it('uploads all local images and replaces srcs with URLs', async () => {
    const t = setup({ upload: async (p) => p.map((_, i) => `https://cdn.example/${i}.png`) });
    const r = await t.uploader.uploadAll();
    expect(r).toEqual({ ok: true, uploaded: 2 });
    expect(t.uploadImages).toHaveBeenCalledWith(['/docs/assets/a.png', '/docs/b c.png'], { kind: 'command', command: "'/opt/my up' -u", timeoutSecs: 7 });
    expect(t.editor.getMarkdown()).toBe('# t\n\n![one](https://cdn.example/0.png) and ![two](<https://cdn.example/1.png>) ![web](https://x/y.png)\n');
    expect(t.notes[t.notes.length - 1]?.[0]).toBe('success');
  });

  it('uploads a single image via PicGo config', async () => {
    const t = setup({ settings: { uploader: 'picgo', picgoPort: 4000 }, upload: async () => ['https://p/1'] });
    expect((await t.uploader.uploadSrcs(['assets/a.png'])).ok).toBe(true);
    expect(t.uploadImages).toHaveBeenCalledWith(['/docs/assets/a.png'], { kind: 'picgo', port: 4000, timeoutSecs: 20 });
    expect(t.editor.getMarkdown()).toContain('![one](https://p/1)');
    expect(t.editor.getMarkdown()).toContain('<b c.png>');
  });

  it('keeps the local image and reports the error when the uploader fails', async () => {
    const t = setup({ upload: async () => Promise.reject('uploader timed out after 30s and was stopped') });
    const r = await t.uploader.uploadAll();
    expect(r.ok).toBe(false);
    expect(t.editor.getMarkdown()).toBe(DOC);
    expect(t.notes[t.notes.length - 1]).toEqual(['error', 'Upload failed: uploader timed out after 30s and was stopped']);
    expect(t.uploader.uploading).toBe(false);
  });

  it('rejects a reply without one URL per image', async () => {
    for (const reply of [['https://only-one'], ['https://a', 'not a url'], 'oops' as unknown as string[]]) {
      const t = setup({ upload: async () => reply });
      expect((await t.uploader.uploadAll()).ok).toBe(false);
      expect(t.editor.getMarkdown()).toBe(DOC);
    }
  });

  it('explains missing capability, configuration and images without calling the platform', async () => {
    expect((await setup().uploader.uploadAll()).ok).toBe(false); // web build: no uploadImages
    const unconfigured = setup({ settings: {}, upload: async () => [] });
    expect(await unconfigured.uploader.uploadAll()).toMatchObject({ ok: false, error: expect.stringContaining('Preferences') });
    const none = setup({ md: '![](https://x/y.png)', upload: async () => [] });
    expect((await none.uploader.uploadAll()).ok).toBe(false);
    const unsaved = setup({ baseDir: null, upload: async () => [] });
    expect((await unsaved.uploader.uploadAll()).ok).toBe(false);
    expect(unconfigured.uploadImages).not.toHaveBeenCalled();
    expect(none.uploadImages).not.toHaveBeenCalled();
  });

  it('refuses a second upload while one is running', async () => {
    let release!: (v: string[]) => void;
    const t = setup({ upload: () => new Promise((res) => (release = res)) });
    const first = t.uploader.uploadSrcs(['assets/a.png']);
    expect(await t.uploader.uploadAll()).toMatchObject({ ok: false, error: expect.stringContaining('already') });
    release(['https://cdn/a']);
    expect((await first).ok).toBe(true);
  });
});

describe('editor context menu', () => {
  function renderedImage(raw: string): HTMLImageElement {
    const host = document.createElement('div');
    host.innerHTML = `<p><span class="md-wrap md-image"><span class="md-meta md-src"></span><img class="md-img"></span></p>`;
    host.querySelector('.md-src')!.textContent = raw;
    document.body.append(host);
    return host.querySelector('img')!;
  }

  it('finds the markdown src of a rendered image', () => {
    expect(imageSrcAt(renderedImage('![a](assets/a.png "t")'))).toBe('assets/a.png');
    expect(imageSrcAt(document.body)).toBeNull();
  });
});

describe('uploader preferences', () => {
  it('shows fields for the chosen uploader and saves valid values', () => {
    const patches: object[] = [];
    const el = uploadPrefsSection({ uploader: 'none' }, (p) => patches.push(p));
    document.body.append(el);
    const q = <T extends HTMLElement>(k: string) => el.querySelector<T>(`[data-pref="${k}"]`)!;
    const rowOf = (k: string) => q(k).closest<HTMLElement>('.pref-row')!;
    expect(rowOf('uploadCommand').hidden).toBe(true);
    const kind = q<HTMLSelectElement>('uploader');
    kind.value = 'command';
    kind.dispatchEvent(new Event('change'));
    expect(rowOf('uploadCommand').hidden).toBe(false);
    expect(rowOf('picgoPort').hidden).toBe(true);
    const cmd = q<HTMLInputElement>('uploadCommand');
    cmd.value = 'picgo upload';
    cmd.dispatchEvent(new Event('change'));
    const port = q<HTMLInputElement>('picgoPort');
    port.value = '70000';
    port.dispatchEvent(new Event('change'));
    port.value = '36678';
    port.dispatchEvent(new Event('change'));
    expect(patches).toEqual([{ uploader: 'command' }, { uploadCommand: 'picgo upload' }, { picgoPort: 36678 }]);
  });

  it('Typora presets (#137): PicGo.app shows the port row, presets show neither', () => {
    const el = uploadPrefsSection({ uploader: 'none' }, () => {});
    document.body.append(el);
    const q = <T extends HTMLElement>(k: string) => el.querySelector<T>(`[data-pref="${k}"]`)!;
    const rowOf = (k: string) => q(k).closest<HTMLElement>('.pref-row')!;
    const kind = q<HTMLSelectElement>('uploader');
    const options = [...kind.options].map((o) => `${o.value}:${o.text}`);
    expect(options).toEqual(['none:None', 'picgo-app:PicGo.app', 'upic:uPic', 'picsee:Picsee', 'command:Custom Command', 'picgo:PicGo (local server)']);
    kind.value = 'picgo-app';
    kind.dispatchEvent(new Event('change'));
    expect(rowOf('picgoPort').hidden).toBe(false);
    expect(rowOf('uploadCommand').hidden).toBe(true);
    expect(rowOf('uploadTimeout').hidden).toBe(false);
    kind.value = 'upic';
    kind.dispatchEvent(new Event('change'));
    expect(rowOf('picgoPort').hidden).toBe(true);
    expect(rowOf('uploadCommand').hidden).toBe(true);
    expect(rowOf('uploadTimeout').hidden).toBe(false);
  });
});
