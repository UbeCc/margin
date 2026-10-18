import { describe, expect, it } from 'vitest';
import type { DirEntry, Platform } from '../../contracts';
import { collectDocs } from './walk';

/** Minimal listDir-only platform: `dirs` maps a folder to its children names. */
const fake = (tree: Record<string, string[]>): Platform => {
  const listDir = async (dir: string): Promise<DirEntry[]> =>
    (tree[dir] ?? []).map((name) => ({
      name,
      path: dir === '/' ? `/${name}` : `${dir}/${name}`,
      isDir: !/\.(md|txt|png)$/.test(name),
      mtime: 0,
      ctime: 0,
      size: 10,
    }));
  return { listDir } as unknown as Platform;
};

describe('collectDocs: TextBundle folders are single documents (#157)', () => {
  it('lists a .textbundle dir as a doc and does not walk into it', async () => {
    const p = fake({
      '/notes': ['journal.textbundle', 'a.md', 'pics'],
      '/notes/journal.textbundle': ['markdown.md', 'text.json', 'assets'],
      '/notes/pics': ['b.md'],
    });
    const { docs } = await collectDocs(p, '/notes');
    const names = docs.map((d) => d.name);
    expect(names).toContain('journal.textbundle');
    expect(names).toContain('a.md');
    expect(names).toContain('b.md'); // sibling folders still walked
    expect(names).not.toContain('markdown.md'); // bundle internals stay hidden
  });

  it('still skips node_modules and dot-folders, bundle or not', async () => {
    const p = fake({ '/r': ['.h.textbundle', 'node_modules', 'ok.textbundle'] });
    const { docs } = await collectDocs(p, '/r');
    expect(docs.map((d) => d.name)).toEqual(['ok.textbundle']);
  });
});
