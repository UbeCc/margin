import type { Platform } from '../contracts';
import { ensureDirs } from './versions';
import { dirname, join } from './util/path';

/**
 * Unsaved-draft recovery (#94: General › Recover Unsaved Drafts). Each window keeps a
 * snapshot of its modified documents in `<data dir>/drafts/<slot>.json` (slot = window
 * label); a clean close empties it. Anything left in a slot when the main window
 * starts was not closed cleanly (crash, kill) and is offered for recovery.
 */

export interface Draft {
  /** File the draft belongs to (null = untitled). */
  path: string | null;
  name: string;
  content: string;
  /** ms since epoch */
  time: number;
}

export interface DraftSlot {
  file: string;
  drafts: Draft[];
}

export class DraftStore {
  private dir: Promise<string> | null = null;
  private last = '';

  constructor(
    private platform: Platform,
    readonly slot: string,
  ) {}

  private root(): Promise<string> {
    this.dir ??= this.platform.themesDir().then((t) => join(dirname(t), 'drafts'));
    return this.dir;
  }

  private async file(slot = this.slot): Promise<string> {
    return join(await this.root(), `${slot.replace(/[^\w-]/g, '_')}.json`);
  }

  /** Replace this window's snapshot (empty list = nothing to recover). */
  async save(drafts: Draft[]): Promise<void> {
    const json = JSON.stringify(drafts);
    if (json === this.last) return;
    this.last = json;
    try {
      const root = await this.root();
      await ensureDirs(this.platform, root);
      await this.platform.writeTextFile(await this.file(), json);
    } catch (e) {
      this.last = '';
      console.warn('[margin] could not write drafts', e);
    }
  }

  /** Non-empty slots of any window (call before this window writes its own). */
  async leftovers(): Promise<DraftSlot[]> {
    let entries;
    try {
      entries = await this.platform.listDir(await this.root());
    } catch {
      return [];
    }
    const out: DraftSlot[] = [];
    for (const e of entries) {
      if (e.isDir || !e.name.endsWith('.json')) continue;
      try {
        const drafts = (JSON.parse(await this.platform.readTextFile(e.path)) as Draft[]).filter(
          (d) => d && typeof d.content === 'string' && (d.path === null || typeof d.path === 'string'),
        );
        if (drafts.length) out.push({ file: e.path, drafts });
      } catch {
        /* unreadable slot */
      }
    }
    return out;
  }

  /** Forget a recovered / dismissed slot. */
  async clear(slot: DraftSlot): Promise<void> {
    await this.platform.writeTextFile(slot.file, '[]').catch(() => undefined);
  }
}
