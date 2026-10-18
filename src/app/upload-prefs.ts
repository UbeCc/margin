import { h } from './util/dom';
import type { UploadConfig } from '../contracts';
import type { UploaderTestReport } from './platform-extras';
import { uploadConfig, uploadSettingsOf, type UploadSettings } from './upload';

/**
 * Preferences › Images › "Image uploader" block (#80). `set` receives the shell
 * keys `uploader`, `uploadCommand`, `picgoPort`, `uploadTimeout`.
 */
export function uploadPrefsSection(
  current: object,
  set: (patch: Partial<UploadSettings>) => void,
  testUploader?: (config: UploadConfig) => Promise<UploaderTestReport>,
): HTMLElement {
  const s = uploadSettingsOf(current);
  let live: UploadSettings = { ...s };
  const put = (patch: Partial<UploadSettings>): void => {
    live = { ...live, ...patch };
    set(patch);
  };
  const kind = h(
    'select.select',
    { 'data-pref': 'uploader' },
    h('option', { value: 'none', text: 'None' }),
    h('option', { value: 'picgo-app', text: 'PicGo.app' }),
    h('option', { value: 'upic', text: 'uPic' }),
    h('option', { value: 'picsee', text: 'Picsee' }),
    h('option', { value: 'command', text: 'Custom Command' }),
    h('option', { value: 'picgo', text: 'PicGo (local server)' }),
  ) as HTMLSelectElement;
  kind.value = s.uploader;

  const command = h('input.text-input', {
    type: 'text',
    spellcheck: 'false',
    placeholder: 'picgo upload',
    value: s.uploadCommand,
    'data-pref': 'uploadCommand',
  }) as HTMLInputElement;
  const port = h('input.number', { type: 'number', min: '1', max: '65535', step: '1', value: String(s.picgoPort), 'data-pref': 'picgoPort' }) as HTMLInputElement;
  const timeout = h('input.number', { type: 'number', min: '1', max: '300', step: '1', value: String(s.uploadTimeout), 'data-pref': 'uploadTimeout' }) as HTMLInputElement;

  const row = (label: string, control: HTMLElement, hint?: string): HTMLElement =>
    h('label.pref-row', null, h('span.pref-label', null, label, hint ? h('span.pref-hint', { text: hint }) : null), h('span.pref-control', null, control));
  const commandRow = row('Upload command', command, 'Program and arguments; image paths are appended. Run directly, not through a shell.');
  const portRow = row('PicGo server port', port, 'Contacted on 127.0.0.1 only.');
  const timeoutRow = row('Timeout per image (s)', timeout);

  // #92: Test Uploader — uploads two bundled sample images, shows argv / output / URLs.
  const report = h('pre.pref-upload-report', { 'data-pref': 'uploadReport', hidden: true });
  const testBtn = h('button.btn.btn-small', {
    type: 'button',
    text: 'Test Uploader',
    'data-pref': 'testUploader',
    onclick: async () => {
      report.hidden = false;
      const config = uploadConfig(live);
      if (typeof config === 'string') return void (report.textContent = `Validation Failed\n${config}`);
      if (!testUploader) return void (report.textContent = 'Validation Failed\nImage upload is only available in the desktop app.');
      report.textContent = 'Validating Image Uploader\nRunning… Waiting for results.';
      testBtn.disabled = true;
      try {
        const r = await testUploader(config);
        const lines = [r.ok ? 'Validation Succeed' : 'Validation Failed', r.message, '', 'Testing image uploading using command:', r.command];
        if (r.urls.length) lines.push('', ...r.urls);
        if (r.stdout.trim()) lines.push('', 'stdout:', r.stdout.trimEnd());
        if (r.stderr.trim()) lines.push('', 'stderr:', r.stderr.trimEnd());
        report.textContent = lines.join('\n');
        report.dataset.ok = String(r.ok);
      } catch (e) {
        report.textContent = `Validation Failed\n${e instanceof Error ? e.message : String(e)}`;
        report.dataset.ok = 'false';
      } finally {
        testBtn.disabled = kind.value === 'none';
      }
    },
  }) as HTMLButtonElement;

  const sync = (): void => {
    commandRow.hidden = kind.value !== 'command';
    portRow.hidden = kind.value !== 'picgo' && kind.value !== 'picgo-app';
    timeoutRow.hidden = kind.value === 'none';
    testBtn.disabled = kind.value === 'none';
  };
  sync();

  kind.addEventListener('change', () => {
    sync();
    put({ uploader: kind.value as UploadSettings['uploader'] });
  });
  command.addEventListener('change', () => put({ uploadCommand: command.value }));
  const intField = (el: HTMLInputElement, key: 'picgoPort' | 'uploadTimeout', min: number, max: number): void => {
    el.addEventListener('change', () => {
      const v = Number(el.value);
      if (Number.isInteger(v) && v >= min && v <= max) put({ [key]: v } as Partial<UploadSettings>);
    });
  };
  intField(port, 'picgoPort', 1, 65535);
  intField(timeout, 'uploadTimeout', 1, 300);

  return h(
    'div.pref-upload',
    { 'data-pref-group': 'upload' },
    h('div.pref-label', { text: 'Image uploader' }),
    row('Uploader', kind),
    commandRow,
    portRow,
    timeoutRow,
    h('div.pref-row', null, testBtn),
    h('p.pref-note', { text: 'The uploader must print one URL per image (http(s), ftp, file, or host.tld/path) as the last lines of its output. Test Uploader uploads two sample images and expects exactly two URLs. PicGo.app is launched by bundle id (com.molunerfinn.picgo) and contacted on 127.0.0.1 — the first connection is retried once after 5 s. uPic and Picsee run their preset command line as separate arguments (never through a shell). Use Upload Image from an image’s context menu, or Upload All Local Images from the command palette.' }),
  );
}
