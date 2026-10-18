import type { Platform } from '../contracts';
import { hashText } from './document';
import { extras } from './platform-extras';
import { dirname, join } from './util/path';

/** Create `dirs` (outermost first) when missing; desktop writes don't create parents. */
export async function ensureDirs(platform: Platform, ...dirs: string[]): Promise<void> {
  const mk = extras(platform).createDir;
  for (const d of dirs) {
    if (await platform.stat(d).catch(() => null)) continue;
    await mk?.call(platform, d).catch(() => undefined);
  }
}

/**
 * Local version history (#94: File › Revert To / Browse All Versions). Every save of a
 * file is kept as `<data dir>/versions/<hash of path>/<ms>.md`, next to a `path.txt`
 * naming the file. Consecutive identical versions are not stored twice, and automatic
 * saves are thinned to one version per `AUTO_INTERVAL`.
 */

export interface Version {
  /** ms since epoch */
  time: number;
  size: number;
  file: string;
}

export const AUTO_INTERVAL = 5 * 60_000;

export class VersionStore {
  private base: Promise<string> | null = null;
  private lastAuto = new Map<string, number>();
  private lastHash = new Map<string, string>();

  constructor(private platform: Platform) {}

  /** `<data dir>/versions`: next to the themes folder in the app's data directory. */
  private root(): Promise<string> {
    this.base ??= this.platform.themesDir().then((t) => join(dirname(t), 'versions'));
    return this.base;
  }

  async dirFor(path: string): Promise<string> {
    return join(await this.root(), hashText(path).replace(/\./g, '-'));
  }

  /** Keep `text` as a version of `path` (quiet = auto-save / background). */
  async record(path: string, text: string, opts: { quiet?: boolean; now?: number } = {}): Promise<boolean> {
    const now = opts.now ?? Date.now();
    if (opts.quiet && now - (this.lastAuto.get(path) ?? 0) < AUTO_INTERVAL) return false;
    const h = hashText(text);
    const dir = await this.dirFor(path);
    if (!this.lastHash.has(path)) {
      const latest = (await this.list(path))[0];
      if (latest) this.lastHash.set(path, hashText(await this.platform.readTextFile(latest.file).catch(() => '')));
    }
    if (this.lastHash.get(path) === h) return false;
    try {
      await ensureDirs(this.platform, await this.root(), dir);
      await this.platform.writeTextFile(join(dir, 'path.txt'), path);
      await this.platform.writeTextFile(join(dir, `${now}.md`), text);
    } catch (e) {
      console.warn('[margin] could not keep a version of', path, e);
      return false;
    }
    this.lastHash.set(path, h);
    if (opts.quiet) this.lastAuto.set(path, now);
    return true;
  }

  /** Versions of `path`, newest first. */
  async list(path: string): Promise<Version[]> {
    const dir = await this.dirFor(path);
    let entries;
    try {
      entries = await this.platform.listDir(dir);
    } catch {
      return [];
    }
    return entries
      .filter((e) => !e.isDir && /^\d+\.md$/.test(e.name))
      .map((e) => ({ time: Number(e.name.slice(0, -3)), size: e.size, file: e.path }))
      .sort((a, b) => b.time - a.time);
  }

  read(v: Version): Promise<string> {
    return this.platform.readTextFile(v.file);
  }

  /** A file was renamed / moved: its history follows it. */
  async moved(from: string, to: string): Promise<void> {
    for (const v of (await this.list(from)).reverse()) {
      await this.record(to, await this.read(v), { now: v.time }).catch(() => false);
    }
  }
}
