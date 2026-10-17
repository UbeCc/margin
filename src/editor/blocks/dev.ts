/**
 * Dev harness: mounts every widget with a fake WidgetContext. Used manually
 * (`npx vite` → /src/editor/blocks/dev.html) and by tests/e2e/blocks-*.spec.ts.
 *
 * window.__blocks exposes { raw[type], events[], instances[type], settings }.
 */
import type { BlockWidget, EditorSettings, Heading, WidgetInstance } from '../../contracts';
import { createWidgets, renderInlineMath, createSourceMode, SourceModeInstance } from './index';

const SAMPLES: Record<string, string> = {
  code_fence: '```js\nfunction hello(name) {\n  // greet\n  return `Hello, ${name}!`;\n}\n```\n',
  code_fence_plain: '~~~~\nplain text\n  indented\n~~~~\n\n',
  math_block: '$$\n\\int_0^1 x^2\\,dx = \\frac{1}{3}\n$$\n',
  diagram: '```mermaid\ngraph TD\n  A[Start] --> B{Ok?}\n  B -->|yes| C[Done]\n  B -->|no| A\n```\n',
  diagram_seq: '```sequence\nAlice->Bob: Hello\nBob-->Alice: Hi!\n```\n',
  table: '| Name | Qty | Note |\n|:-----|----:|------|\n| apple | 3 | **fresh** |\n| pear | 10 | `x` and $a^2$ |\n',
  html_block: '<div align="center">\n  <b>Bold HTML</b> <img src="x.png" onerror="window.__pwned=1">\n  <script>window.__pwned = 2</script>\n</div>\n',
  front_matter: '---\ntitle: Margin\ntags: [editor, markdown]\ndate: 2026-10-17\n---\n',
  toc: '[toc]\n',
};

const headings: Heading[] = [
  { id: 'h-intro', level: 1, text: 'Introduction' },
  { id: 'h-usage', level: 2, text: 'Usage' },
  { id: 'h-details', level: 3, text: 'Details' },
];

let settings: EditorSettings = {
  baseDir: null,
  resolveAsset: (s) => s,
  spellcheck: false,
  focusMode: false,
  typewriterMode: false,
  colorScheme: 'light',
};

const state = {
  raw: {} as Record<string, string>,
  events: [] as string[],
  instances: {} as Record<string, WidgetInstance>,
  headings,
  get settings() {
    return settings;
  },
  source: null as SourceModeInstance | null,
  sourceMd: '',
};
(window as unknown as { __blocks: typeof state }).__blocks = state;

const app = document.getElementById('app')!;
const widgets = new Map<string, BlockWidget>(createWidgets({ math: { numbering: true } }).map((w) => [w.type, w]));

function para(text: string, name: string) {
  const p = document.createElement('p');
  p.className = 'fake-para';
  p.tabIndex = 0;
  p.dataset.para = name;
  p.textContent = text;
  return p;
}

function mount(key: string, type: string) {
  const sec = document.createElement('section');
  sec.dataset.key = key;
  const h2 = document.createElement('h2');
  h2.textContent = key;
  const host = document.createElement('div');
  host.className = 'host';
  host.dataset.host = key;
  const before = para('paragraph before ' + key, key + '-before');
  const after = para('paragraph after ' + key, key + '-after');
  const raw = document.createElement('pre');
  raw.className = 'raw';
  raw.dataset.raw = key;
  const log = document.createElement('div');
  log.className = 'log';
  log.dataset.log = key;
  sec.append(h2, before, host, after, raw, log);
  app.append(sec);

  state.raw[key] = SAMPLES[key];
  raw.textContent = SAMPLES[key];
  const ev = (s: string) => {
    state.events.push(`${key}:${s}`);
    log.textContent = s;
  };
  const inst = widgets.get(type)!.mount(host, {
    raw: SAMPLES[key],
    settings,
    onChange(r) {
      state.raw[key] = r;
      raw.textContent = r;
      ev('change');
    },
    onExit(d) {
      ev('exit-' + d);
      const target = d === 'up' || d === 'left' ? before : after;
      target.focus();
      document.querySelectorAll('.fake-para.active').forEach((x) => x.classList.remove('active'));
      target.classList.add('active');
    },
    onRemove() {
      ev('remove');
    },
    getOutline: () => headings,
    scrollToHeading(id) {
      ev('scroll-' + id);
    },
  });
  state.instances[key] = inst;
  // Arrow down from "before" paragraph enters the widget (simulates core caret hand-off)
  before.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      inst.focus('start');
    }
  });
  after.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowUp') {
      e.preventDefault();
      inst.focus('end');
    }
  });
}

mount('code_fence', 'code_fence');
mount('code_fence_plain', 'code_fence');
mount('math_block', 'math_block');
mount('diagram', 'diagram');
mount('diagram_seq', 'diagram');
mount('table', 'table');
mount('html_block', 'html_block');
mount('front_matter', 'front_matter');
mount('toc', 'toc');

// inline math demo
{
  const sec = document.createElement('section');
  sec.innerHTML = '<h2>inline math</h2><p>Euler: <span data-imath="ok"></span>, broken: <span data-imath="bad"></span></p>';
  app.append(sec);
  renderInlineMath('e^{i\\pi} + 1 = 0', sec.querySelector('[data-imath=ok]')!);
  renderInlineMath('\\frac{1', sec.querySelector('[data-imath=bad]')!);
}

// source mode
{
  const sec = document.createElement('section');
  sec.innerHTML = '<h2>source mode</h2><div id="source-host"></div><pre class="raw" data-raw="source"></pre>';
  app.append(sec);
  const md = '# Title\n\nSome *emphasis* and **strong** text.\n\n```js\nconst x = 1;\n```\n\n- item\n- item two\n';
  state.sourceMd = md;
  state.source = createSourceMode(sec.querySelector('#source-host') as HTMLElement, {
    markdown: md,
    settings,
    onChange(m) {
      state.sourceMd = m;
      (sec.querySelector('[data-raw=source]') as HTMLElement).textContent = m;
    },
  });
}

document.getElementById('theme-toggle')!.addEventListener('click', () => {
  settings = { ...settings, colorScheme: settings.colorScheme === 'dark' ? 'light' : 'dark' };
  document.body.classList.toggle('dark', settings.colorScheme === 'dark');
  for (const inst of Object.values(state.instances)) inst.updateSettings?.(settings);
  state.source?.updateSettings(settings);
});

document.getElementById('export')!.addEventListener('click', () => {
  let out = document.getElementById('export-out');
  if (!out) {
    const sec = document.createElement('section');
    sec.innerHTML = '<h2>export</h2><div id="export-out"></div>';
    app.append(sec);
    out = document.getElementById('export-out')!;
  }
  out.innerHTML = Object.values(state.instances)
    .map((i) => i.renderHTML())
    .join('\n');
});

document.getElementById('status')!.textContent = 'ready';
