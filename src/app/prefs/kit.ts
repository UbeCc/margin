/** Small control builders shared by the Preferences panes (#100). */
import type { MarkdownOptions } from '../../contracts';
import type { MarginSettings } from '../settings';
import { h } from '../util/dom';

export interface PrefKit {
  cur(): MarginSettings;
  set(patch: Partial<MarginSettings>): void;
  /** Patch one Markdown / Editor option (nested `markdown` settings key). */
  setMd(patch: Partial<MarkdownOptions>): void;
  row(label: string, control: HTMLElement, hint?: string): HTMLElement;
  group(title: string, ...kids: (HTMLElement | null)[]): HTMLElement;
  toggle(key: keyof MarginSettings, label: string, hint?: string): HTMLElement;
  mdToggle(key: keyof MarkdownOptions, label: string, hint?: string): HTMLElement;
  select(key: string, options: [string, string][], value: string, onChange: (v: string) => void): HTMLSelectElement;
  radios(name: string, options: [string, string][], value: string, onChange: (v: string) => void, extra?: Record<string, HTMLElement>): HTMLElement;
  note(text: string): HTMLElement;
}

export function prefKit(cur: () => MarginSettings, set: (p: Partial<MarginSettings>) => void): PrefKit {
  const row = (label: string, control: HTMLElement, hint?: string): HTMLElement =>
    h('label.pref-row', null, h('span.pref-label', null, label, hint ? h('span.pref-hint', { text: hint }) : null), h('span.pref-control', null, control));
  const check = (key: string, value: boolean, onChange: (v: boolean) => void): HTMLInputElement => {
    const input = h('input.switch', { type: 'checkbox', role: 'switch', 'data-pref': key });
    input.checked = value;
    input.addEventListener('change', () => onChange(input.checked));
    return input;
  };
  const setMd = (patch: Partial<MarkdownOptions>): void => set({ markdown: { ...cur().markdown, ...patch } });
  return {
    cur,
    set,
    setMd,
    row,
    group: (title, ...kids) => h('div.pref-group', { 'data-group': title }, h('h3.pref-group-title', { text: title }), ...kids),
    toggle: (key, label, hint) => row(label, check(String(key), Boolean(cur()[key]), (v) => set({ [key]: v } as Partial<MarginSettings>)), hint),
    mdToggle: (key, label, hint) => row(label, check(`markdown.${key}`, Boolean(cur().markdown[key]), (v) => setMd({ [key]: v })), hint),
    select(key, options, value, onChange) {
      const el = h('select.select', { 'data-pref': key }, ...options.map(([v, l]) => h('option', { value: v, text: l })));
      el.value = value;
      el.addEventListener('change', () => onChange(el.value));
      return el;
    },
    radios(name, options, value, onChange, extra = {}) {
      return h(
        'div.radio-group',
        { role: 'radiogroup', 'data-pref': name },
        ...options.map(([v, l]) => {
          const r = h('input', { type: 'radio', name, value: v });
          r.checked = v === value;
          r.addEventListener('change', () => r.checked && onChange(v));
          return h('label.radio', null, r, h('span', { text: l }), extra[v] ?? null);
        }),
      );
    },
    note: (text) => h('p.pref-note', { text }),
  };
}
