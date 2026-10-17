/**
 * THE single integration point between the app shell and the other modules.
 *
 * Real modules are discovered with `import.meta.glob`, so once
 *   src/editor/core/index.ts      (export const createEditor: CreateEditor)
 *   src/editor/blocks/index.ts    (export function installBlocks(...))
 *   src/platform/tauri.ts / web.ts (a Platform)
 * exist, they are used automatically; until then the dev stubs are used.
 * Force stubs with `?stub=all` / `?stub=editor` / `?stub=platform` (e2e tests do).
 *
 * If the integrator prefers static imports, replace `loadWiring` with:
 *   import { createEditor } from '../editor/core';
 *   import { installBlocks } from '../editor/blocks';
 *   import { platform } from '../platform/tauri'; …
 */
import type { CreateEditor, Platform } from '../contracts';

export interface Wiring {
  createEditor: CreateEditor;
  platform: Platform;
  /** Which implementation was chosen (shown in the dev console / used by tests). */
  using: { editor: 'core' | 'stub'; platform: 'tauri' | 'web' | 'stub'; blocks: boolean };
}

type Loader = () => Promise<Record<string, unknown>>;

const coreMods = import.meta.glob('../editor/core/index.ts') as Record<string, Loader>;
const blockMods = import.meta.glob('../editor/blocks/index.ts') as Record<string, Loader>;
const tauriMods = import.meta.glob('../platform/tauri.ts') as Record<string, Loader>;
const webMods = import.meta.glob('../platform/web.ts') as Record<string, Loader>;

function first(mods: Record<string, Loader>): Loader | null {
  const k = Object.keys(mods)[0];
  return k ? mods[k] : null;
}

const isPlatform = (v: unknown): v is Platform =>
  typeof v === 'object' && v !== null && 'readTextFile' in v && 'kind' in v;

/** Accept `export const platform`, `export default`, or a `create*Platform()` factory. */
async function pickPlatform(mod: Record<string, unknown>): Promise<Platform | null> {
  for (const key of ['platform', 'default', 'tauriPlatform', 'webPlatform']) {
    if (isPlatform(mod[key])) return mod[key] as Platform;
  }
  for (const [key, v] of Object.entries(mod)) {
    if (typeof v === 'function' && /^create\w*Platform$/i.test(key)) {
      const p = await (v as () => Platform | Promise<Platform>)();
      if (isPlatform(p)) return p;
    }
  }
  for (const v of Object.values(mod)) if (isPlatform(v)) return v;
  return null;
}

export function isTauri(): boolean {
  return typeof window !== 'undefined' && ('__TAURI_INTERNALS__' in window || '__TAURI__' in window);
}

export async function loadWiring(): Promise<Wiring> {
  const force = new URLSearchParams(location.search).get('stub') ?? '';
  const forceEditor = /all|editor/.test(force);
  const forcePlatform = /all|platform/.test(force);

  let createEditor: CreateEditor | null = null;
  let editorKind: Wiring['using']['editor'] = 'stub';
  let blocks = false;
  const coreLoader = first(coreMods);
  if (coreLoader && !forceEditor) {
    try {
      const blocksLoader = first(blockMods);
      if (blocksLoader) {
        const bm = await blocksLoader();
        if (typeof bm.installBlocks === 'function') {
          (bm.installBlocks as () => void)();
          blocks = true;
        }
      }
      const cm = await coreLoader();
      const ce = (cm.createEditor ?? cm.default) as CreateEditor | undefined;
      if (typeof ce === 'function') {
        createEditor = ce;
        editorKind = 'core';
      }
    } catch (e) {
      console.error('[margin] failed to load editor core, falling back to stub', e);
    }
  }

  let platform: Platform | null = null;
  let platformKind: Wiring['using']['platform'] = 'stub';
  if (!forcePlatform) {
    const loader = isTauri() ? first(tauriMods) : first(webMods);
    if (loader) {
      try {
        platform = await pickPlatform(await loader());
        if (platform) platformKind = platform.kind;
      } catch (e) {
        console.error('[margin] failed to load platform, falling back to stub', e);
      }
    }
  }

  if (!createEditor || !platform) {
    const stubs = await import('./dev-stubs');
    createEditor ??= stubs.createStubEditor;
    platform ??= stubs.createMemoryPlatform();
  }
  const using = { editor: editorKind, platform: platformKind, blocks };
  console.info('[margin] wiring', using);
  return { createEditor, platform, using };
}
