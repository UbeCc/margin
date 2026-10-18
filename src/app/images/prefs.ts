import type { ImageRule } from '../../contracts';
import { h } from '../util/dom';
import { isAbsolute } from '../util/path';
import { imageOptionsOf, type ImageOptions } from './rules';

/** Typora's "When Insert…" choices (Preferences › Image), in Typora's order and wording. */
export const INSERT_ACTIONS = [
  { id: 'none', label: 'No special action' },
  { id: 'folder', label: 'Copy image to current folder (./)' },
  { id: 'assets', label: 'Copy image to ./assets' },
  { id: 'filename', label: 'Copy image to ./${filename}.assets' },
  { id: 'custom', label: 'Copy image to custom folder' },
  { id: 'upload', label: 'Upload image' },
] as const;
export type InsertActionId = (typeof INSERT_ACTIONS)[number]['id'];

export function insertActionOf(rule: ImageRule, o: ImageOptions): InsertActionId {
  if (o.imageUploadOnInsert) return 'upload';
  if (rule.kind === 'none') return 'none';
  if (rule.kind === 'absolute') return 'custom';
  const d = rule.dir.replace(/\/+$/, '');
  if (d === '.' || d === '') return 'folder';
  if (d === './assets' || d === 'assets') return 'assets';
  if (d === './${filename}.assets' || d === '${filename}.assets') return 'filename';
  return 'custom';
}

/** Rule written for a choice (custom: absolute or document-relative folder). */
export function ruleForAction(id: InsertActionId, custom: string, prev: ImageRule): ImageRule | null {
  switch (id) {
    case 'none':
      return { kind: 'none' };
    case 'folder':
      return { kind: 'relative', dir: './' };
    case 'assets':
      return { kind: 'relative', dir: './assets' };
    case 'filename':
      return { kind: 'relative', dir: './${filename}.assets' };
    case 'upload':
      return prev; // uploading keeps the copy rule for the local fallback
    case 'custom': {
      const d = custom.trim();
      if (!d) return null;
      return isAbsolute(d) || d.startsWith('~') ? { kind: 'absolute', dir: d } : { kind: 'relative', dir: d.startsWith('.') ? d : `./${d}` };
    }
  }
}

type Patch = { imageRule?: ImageRule } & Partial<ImageOptions>;

/** Preferences › Images: insert action, scope toggles, path options and preferred syntax. */
export function imageRulesSection(current: { imageRule: ImageRule } & object, set: (p: Patch) => void, pickFolder: () => Promise<string | null>): HTMLElement {
  const o = imageOptionsOf(current);
  let rule = current.imageRule;
  const act = insertActionOf(rule, o);
  const customValue = act === 'custom' && rule.kind !== 'none' ? rule.dir : '';
  const custom = h('input.text-input', { type: 'text', placeholder: './images or /path/to/images', value: customValue, 'data-pref': 'imageCustomDir', spellcheck: 'false' }) as HTMLInputElement;
  const radios: HTMLInputElement[] = [];
  const apply = (): void => {
    const id = radios.find((r) => r.checked)?.value as InsertActionId | undefined;
    if (!id) return;
    const next = ruleForAction(id, custom.value, rule);
    if (!next) return;
    rule = next;
    set({ imageRule: next, imageUploadOnInsert: id === 'upload' });
  };
  const browse = h('button.btn.btn-small', {
    type: 'button',
    text: 'Select custom folder',
    'data-pref': 'imageCustomBrowse',
    onclick: async () => {
      const p = await pickFolder();
      if (!p) return;
      custom.value = p;
      radios.find((r) => r.value === 'custom')!.checked = true;
      apply();
    },
  });
  custom.addEventListener('change', () => {
    radios.find((r) => r.value === 'custom')!.checked = true;
    apply();
  });

  const check = (key: keyof ImageOptions, label: string): HTMLElement => {
    const box = h('input', { type: 'checkbox', 'data-pref': key }) as HTMLInputElement;
    box.checked = o[key] as boolean;
    box.addEventListener('change', () => set({ [key]: box.checked } as Patch));
    return h('label.check', null, box, h('span', { text: label }));
  };
  const syntax = h('select.select', { 'data-pref': 'imageSyntax' }, h('option', { value: 'markdown', text: 'Markdown' }), h('option', { value: 'html', text: 'HTML' })) as HTMLSelectElement;
  syntax.value = o.imageSyntax;
  syntax.addEventListener('change', () => set({ imageSyntax: syntax.value === 'html' ? 'html' : 'markdown' }));

  return h(
    'div.pref-image-rules',
    { 'data-pref-group': 'image-rules' },
    h('div.pref-label', { text: 'When Insert…' }),
    h(
      'div.radio-group',
      { role: 'radiogroup' },
      ...INSERT_ACTIONS.map((a) => {
        const r = h('input', { type: 'radio', name: 'imageInsertAction', value: a.id }) as HTMLInputElement;
        r.checked = a.id === act;
        r.addEventListener('change', apply);
        radios.push(r);
        return h('label.radio', null, r, h('span', { text: a.label }), a.id === 'custom' ? h('span.inline', null, custom, browse) : null);
      }),
    ),
    h('p.pref-note', { text: '${filename} is replaced with the document name. A typora-copy-images-to front matter value overrides this choice.' }),
    check('imageApplyLocal', 'Apply above rules to local images'),
    check('imageApplyOnline', 'Apply above rules to online images'),
    check('imageUseRelative', 'Use relative path if possible'),
    check('imageDotPrefix', 'Add ./ for relative path'),
    check('imageAutoEscape', 'Auto escape image URL when insert'),
    check('imageAllowYamlUpload', 'Allow upload images automatically based on YAML settings'),
    h('label.pref-row', null, h('span.pref-label', { text: 'Preferred Image Syntax' }), h('span.pref-control', null, syntax)),
  );
}
