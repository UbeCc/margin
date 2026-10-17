/**
 * THE single integration point between the app shell and the other modules.
 *
 *  - Platform: `getPlatform()` from src/platform (TauriPlatform in the app, WebPlatform in a browser).
 *  - Blocks:   `installBlocks` from src/editor/blocks, registered with the core's widget registry;
 *              `blocksCSS` is loaded on demand for exports.
 *  - Editor:   `loadCore` below. Until the core (#1) lands it resolves to null and a <textarea>
 *              stub is used (also forced with `?stub=editor`).
 *
 * Heavy modules (blocks → CodeMirror/KaTeX, the core) are dynamic imports so the shell
 * paints before they are parsed.
 */
import type { CreateEditor, Platform } from '../contracts';
import { getPlatform } from '../platform';
import { createStubEditor } from './dev-stubs';

type CoreModule = Record<string, unknown>;

// ──── swap to the real core when #1 merges (one line): ──────────────────────────────
//   const loadCore = (): Promise<CoreModule | null> => import('../editor/core');
const loadCore = (): Promise<CoreModule | null> => Object.values(import.meta.glob<CoreModule>('../editor/core/index.ts'))[0]?.() ?? Promise.resolve(null);
// ──────────────────────────────────────────────────────────────────────────────────────

export interface Wiring {
  createEditor: CreateEditor;
  platform: Platform;
  /** Widget CSS from editor/blocks, inlined into exported HTML/PDF. */
  loadBlocksCss(): Promise<string>;
  /** Which implementation was chosen (dev console / tests). */
  using: { editor: 'core' | 'stub'; platform: Platform['kind']; blocks: boolean };
}

const loadBlocks = () => import('../editor/blocks');

/** Register the block widgets with the core, unless the core already did it itself. */
async function wireBlocks(core: CoreModule): Promise<boolean> {
  if (core.blocksInstalled === true) return true;
  const { registerWidget, registerInlineMath, registerSourceMode } = core;
  if (typeof registerWidget !== 'function') return false;
  const { installBlocks } = await loadBlocks();
  installBlocks({ registerWidget, registerInlineMath, registerSourceMode } as Parameters<typeof installBlocks>[0]);
  return true;
}

export async function loadWiring(): Promise<Wiring> {
  const forceStub = /all|editor/.test(new URLSearchParams(location.search).get('stub') ?? '');
  let createEditor: CreateEditor = createStubEditor;
  let editor: Wiring['using']['editor'] = 'stub';
  let blocks = false;

  if (!forceStub) {
    try {
      const core = await loadCore();
      const ce = (core?.createEditor ?? core?.default) as CreateEditor | undefined;
      if (core && typeof ce === 'function') {
        blocks = await wireBlocks(core);
        createEditor = ce;
        editor = 'core';
      }
    } catch (e) {
      console.error('[margin] failed to load editor core, using the textarea stub', e);
    }
  }

  const platform = getPlatform();
  const using = { editor, platform: platform.kind, blocks };
  console.info('[margin] wiring', using);
  return { createEditor, platform, loadBlocksCss: async () => (await loadBlocks()).blocksCSS, using };
}
