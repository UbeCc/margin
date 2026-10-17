/**
 * THE single integration point between the app shell and the other modules.
 *
 *  - Platform: `getPlatform()` from src/platform (Tauri in the app, WebPlatform in a browser).
 *  - Blocks:   `installBlocks` + `blocksCSS` from src/editor/blocks.
 *  - Editor:   src/editor/core/index.ts (`createEditor`) is discovered with `import.meta.glob`;
 *              until the core lands (or with `?stub=editor`) a <textarea> stub is used.
 *
 * When the core is merged the integrator may replace the glob with a static
 * `import { createEditor } from '../editor/core'` — nothing else imports these modules.
 */
import type { CreateEditor, Platform } from '../contracts';
import { getPlatform } from '../platform';
import { blocksCSS, installBlocks, type BlocksApi } from '../editor/blocks';
import { createStubEditor } from './dev-stubs';

export interface Wiring {
  createEditor: CreateEditor;
  platform: Platform;
  /** Widget CSS from editor/blocks, inlined into exported HTML/PDF. */
  blocksCss: string;
  /** Which implementation was chosen (dev console / tests). */
  using: { editor: 'core' | 'stub'; platform: Platform['kind']; blocks: boolean };
}

type Loader = () => Promise<Record<string, unknown>>;
const coreMods = import.meta.glob('../editor/core/index.ts') as Record<string, Loader>;

let blocksInstalled = false;

/** Register the block widgets with the core, unless the core already did it itself. */
function wireBlocks(core: Record<string, unknown>): boolean {
  if (blocksInstalled || core.blocksInstalled === true) return true;
  const { registerWidget, registerInlineMath, registerSourceMode } = core;
  if (typeof registerWidget !== 'function') return false;
  installBlocks({ registerWidget, registerInlineMath, registerSourceMode } as BlocksApi);
  blocksInstalled = true;
  return true;
}

export async function loadWiring(): Promise<Wiring> {
  const forceStub = /all|editor/.test(new URLSearchParams(location.search).get('stub') ?? '');
  let createEditor: CreateEditor = createStubEditor;
  let editor: Wiring['using']['editor'] = 'stub';
  let blocks = false;

  const loader = Object.values(coreMods)[0];
  if (loader && !forceStub) {
    try {
      const core = await loader();
      const ce = (core.createEditor ?? core.default) as CreateEditor | undefined;
      if (typeof ce === 'function') {
        blocks = wireBlocks(core);
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
  return { createEditor, platform, blocksCss: blocksCSS, using };
}
