import { describe, expect, it, vi } from 'vitest';
import type { Platform } from '../../contracts';
import { convertForImport, importKind, runImport, type ImportHost } from '../import';
import { migrateCustomExports, migrateExportSettings } from '../export-settings';

function host(extra: Record<string, unknown> = {}, files: Record<string, string> = {}) {
  const notes: [string, string, unknown][] = [];
  const opened: string[] = [];
  const h: ImportHost = {
    platform: { openFileDialog: vi.fn(async () => null), readTextFile: vi.fn(async (p: string) => files[p] ?? '') , ...extra } as unknown as Platform,
    pandocPath: () => '',
    openAsNew: async (md) => {
      opened.push(md);
      return true;
    },
    progress: () => () => undefined,
    notify: (m, k, a) => void notes.push([m, k, a]),
    htmlToMarkdown: async (html) => `MD(${html.length})`,
    openPandocSettings: vi.fn(),
  };
  return { h, notes, opened };
}

describe('import', () => {
  it('classifies files', () => {
    expect(importKind('/a/b.HTML')).toBe('html');
    expect(importKind('/a/b.docx')).toBe('pandoc');
    expect(importKind('/a/b.md')).toBeNull();
  });
  it('HTML falls back to the built-in converter when Pandoc is missing or fails', async () => {
    const a = host({}, { '/x.html': '<h1>x</h1>' });
    expect(await convertForImport(a.h, '/x.html')).toBe('MD(10)');
    const b = host({ pandocImport: vi.fn(async () => { throw new Error('pandoc too old'); }) }, { '/x.html': '<p>y</p>' });
    expect(await convertForImport(b.h, '/x.html')).toBe('MD(8)');
  });
  it('Pandoc-only formats need Pandoc; its errors propagate', async () => {
    await expect(convertForImport(host().h, '/r.docx')).rejects.toThrow(/Pandoc is needed/);
    const c = host({ pandocImport: vi.fn(async () => { throw new Error('Pandoc failed: bad zip'); }) });
    await expect(convertForImport(c.h, '/r.docx')).rejects.toThrow(/bad zip/);
    const d = host({ pandocImport: vi.fn(async (_p: string, path: string | null, t: number) => `# ok ${path} ${t > 0}`) });
    expect(await convertForImport(d.h, '/r.odt')).toBe('# ok null true');
  });
  it('runImport opens the result, offers "Set Pandoc Path" on missing Pandoc', async () => {
    const a = host({}, { '/p.htm': '<b>x</b>' });
    expect(await runImport(a.h, '/p.htm')).toBe(true);
    expect(a.opened).toEqual(['MD(8)']);
    const b = host();
    expect(await runImport(b.h, '/q.docx')).toBe(false);
    const [m, kind, action] = b.notes[0];
    expect(kind).toBe('error');
    expect(m).toMatch(/Import failed: failed to import file from q\.docx/);
    (action as { run: () => void }).run();
    expect(b.h.openPandocSettings).toHaveBeenCalled();
    expect(await runImport(host().h)).toBe(false); // panel cancelled
  });
});

describe('custom export settings', () => {
  it('validates entries, dedupes ids, caps the list', () => {
    const list = migrateCustomExports([
      { id: 'a', name: ' Pdf ', command: 'pandoc -o ${outputPath}', extension: '.pdf', input: 'html', saveDialog: false },
      { id: 'a', name: '', command: 5, extension: 'x/../y' },
      'garbage',
    ]);
    expect(list[0]).toEqual({ id: 'a', name: 'Pdf', command: 'pandoc -o ${outputPath}', extension: 'pdf', input: 'html', saveDialog: false });
    expect(list[1].id).not.toBe('a');
    expect(list[1]).toMatchObject({ name: 'Custom export', command: '', extension: 'x..y', input: 'markdown', saveDialog: true });
    expect(list).toHaveLength(3);
    expect(migrateCustomExports(Array.from({ length: 80 }, () => ({})))).toHaveLength(50);
    expect(migrateExportSettings({ general: { runAfterExport: 'open ${outputPath}' } }).general.runAfterExport).toBe('open ${outputPath}');
  });
});
