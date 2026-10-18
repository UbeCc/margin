import { h } from './util/dom';
import { uploadSettingsOf, type UploadSettings } from './upload';

/**
 * Preferences › Images › "Image uploader" block (#80). `set` receives the shell
 * keys `uploader`, `uploadCommand`, `picgoPort`, `uploadTimeout`.
 */
export function uploadPrefsSection(current: object, set: (patch: Partial<UploadSettings>) => void): HTMLElement {
  const s = uploadSettingsOf(current);
  const kind = h(
    'select.select',
    { 'data-pref': 'uploader' },
    h('option', { value: 'none', text: 'None' }),
    h('option', { value: 'command', text: 'Custom command' }),
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

  const sync = (): void => {
    commandRow.hidden = kind.value !== 'command';
    portRow.hidden = kind.value !== 'picgo';
    timeoutRow.hidden = kind.value === 'none';
  };
  sync();

  kind.addEventListener('change', () => {
    sync();
    set({ uploader: kind.value as UploadSettings['uploader'] });
  });
  command.addEventListener('change', () => set({ uploadCommand: command.value }));
  const intField = (el: HTMLInputElement, key: 'picgoPort' | 'uploadTimeout', min: number, max: number): void => {
    el.addEventListener('change', () => {
      const v = Number(el.value);
      if (Number.isInteger(v) && v >= min && v <= max) set({ [key]: v } as Partial<UploadSettings>);
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
    h('p.pref-note', { text: 'The uploader must print one http(s) URL per image as the last lines of its output. Use Upload Image from an image’s context menu, or Upload All Local Images from the command palette.' }),
  );
}
