/**
 * Dev harness for the editing core (`npx vite` → /src/editor/core/dev.html).
 * Used by tests/e2e/core-*.spec.ts through `window.__core`.
 * `?blocks=0` skips the real block widgets (fallback <pre> widgets).
 */
import type { ClipboardSnapshot, EditorHandle, EditorSettings, RichClipboardData } from '../../contracts';
import { createEditor, registerWidget, registerInlineMath, registerSourceMode, OUTLINE_EVENT } from './index';

const SAMPLE = `# Margin core

Some *emphasis*, **strong**, \`code\`, ~~strike~~, ==mark== and a [link](https://example.com).
Inline math $a^2+b^2$ and an image ![dot](data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7).

## Lists

- one
- two
  - nested
- [ ] task
- [x] done

1. first
2. second

> quote line
> more

---

\`\`\`js
const x = 1;
\`\`\`

| a | b |
|---|---|
| 1 | 2 |
`;

declare global {
  interface Window {
    __core: {
      ed: EditorHandle;
      md(): string;
      changes: number;
      outlineEvents: number;
      opened: string[];
      ready: boolean;
      /** `?clipread`: what EditorSettings.readClipboard (native pasteboard, #96) returns. */
      clip: ClipboardSnapshot | null;
      /** `?mathimg`: Copy Math ▸ Copy as Image calls seen by the stub rasterizer (#127). */
      mathimgs: { tex: string; display: boolean }[];
    };
  }
}

async function main() {
  const params = new URLSearchParams(location.search);
  if (params.get('blocks') !== '0') {
    const { installBlocks } = await import('../blocks');
    installBlocks({ registerWidget, registerInlineMath, registerSourceMode } as Parameters<typeof installBlocks>[0]);
  }
  const opened: string[] = [];
  const settings: EditorSettings = {
    baseDir: null,
    resolveAsset: (s) => s,
    storeImage: async (i) => `assets/${i.name ?? 'image.png'}`,
    openLink: (h) => void opened.push(h),
    spellcheck: false,
    focusMode: false,
    typewriterMode: false,
    colorScheme: 'light',
  };
  const rich: RichClipboardData[] = [];
  if (params.has('rich')) settings.writeClipboardRich = async (d) => (rich.push(d), true);
  if (params.has('clipread')) settings.readClipboard = async () => window.__core.clip;
  /** `?mathimg`: record Copy Math ▸ Copy as Image calls instead of rasterizing (#127). */
  const mathimgs: { tex: string; display: boolean }[] = [];
  if (params.has('mathimg')) settings.copyMathImage = async (tex, display) => (mathimgs.push({ tex, display }), true);
  const host = document.getElementById('host')!;
  const ed = createEditor(host, settings);
  const md = params.has('empty') ? '' : (params.get('md') ?? SAMPLE);
  ed.setMarkdown(md);
  const state = { ed, md: () => ed.getMarkdown(), changes: 0, outlineEvents: 0, opened, ready: true, rich, clip: null as ClipboardSnapshot | null, mathimgs };
  window.__core = state;
  ed.onChange(() => state.changes++);
  document.addEventListener(OUTLINE_EVENT, () => state.outlineEvents++);
  const status = document.getElementById('status')!;
  status.textContent = 'ready';
  document.getElementById('source')!.onclick = () => ed.setSourceMode(!ed.isSourceMode());
  document.getElementById('export')!.onclick = () => console.log(ed.renderHTML());
}

void main();
