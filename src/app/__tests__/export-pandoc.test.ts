import { describe, expect, it, vi } from 'vitest';
import { exportWithPandoc, pandocFormatForAction, withExtension, type PandocExportDeps } from '../export-pandoc';
import { migrateSettings } from '../settings';

type Notice = { message: string; kind: string; action?: unknown };

function setup(over: Partial<PandocExportDeps> & { save?: () => Promise<string | null> } = {}) {
  const notices: Notice[] = [];
  let open = 0; // currently visible progress notices
  let shown = 0;
  const pandocExport = vi.fn(async (_md: string, _out: string, _opts: unknown) => '');
  const deps: PandocExportDeps = {
    platform: { saveFileDialog: over.save ?? (async () => '/out/doc.docx'), pandocExport },
    markdown: '# Doc\n',
    name: 'doc',
    docDir: '/docs',
    fallbackDir: null,
    title: 'Doc',
    pandocPath: '',
    progress: () => {
      open++;
      shown++;
      return () => open--;
    },
    notify: (message, kind, action) => notices.push({ message, kind, action }),
    ...over,
  };
  return { deps, notices, pandocExport, progress: () => ({ open, shown }) };
}

/** Every case: the returned promise settles, progress is cleared, ≤1 terminal notice. */
async function settles(p: Promise<boolean>): Promise<boolean> {
  return await p; // a never-settling promise fails the test by timeout
}

describe('pandoc export flow always settles', () => {
  it('success: clears progress, success notice, passes argv-level options', async () => {
    const t = setup({ pandocPath: '  /opt/homebrew/bin  ' });
    expect(await settles(exportWithPandoc('docx', t.deps))).toBe(true);
    expect(t.progress()).toEqual({ open: 0, shown: 1 });
    expect(t.notices).toEqual([{ message: 'Exported doc.docx', kind: 'success', action: undefined }]);
    expect(t.pandocExport).toHaveBeenCalledWith('# Doc\n', '/out/doc.docx', {
      format: 'docx',
      docDir: '/docs',
      title: 'Doc',
      pandocPath: '/opt/homebrew/bin',
      timeoutMs: 120_000,
    });
  });

  it('warnings are shown, with a reveal action when available', async () => {
    const reveal = vi.fn();
    const t = setup({ reveal });
    t.pandocExport.mockResolvedValueOnce('[WARNING] Could not fetch resource x.png\nmore');
    expect(await exportWithPandoc('docx', t.deps)).toBe(true);
    expect(t.notices[0].kind).toBe('warning');
    expect(t.notices[0].message).toContain('Could not fetch resource x.png');
    expect(t.notices[0].message).not.toContain('more');
    (t.notices[0].action as { run(): void }).run();
    expect(reveal).toHaveBeenCalledWith('/out/doc.docx');
  });

  it('cancelled save dialog: no progress, no notice', async () => {
    const t = setup({ save: async () => null });
    expect(await settles(exportWithPandoc('latex', t.deps))).toBe(false);
    expect(t.progress().shown).toBe(0);
    expect(t.notices).toEqual([]);
    expect(t.pandocExport).not.toHaveBeenCalled();
  });

  it('save dialog throwing reports an error', async () => {
    const t = setup({ save: async () => Promise.reject(new Error('dialog broke')) });
    expect(await settles(exportWithPandoc('docx', t.deps))).toBe(false);
    expect(t.notices).toEqual([{ message: 'Export failed: dialog broke', kind: 'error', action: undefined }]);
  });

  it('adds the extension and defaults the dialog to the doc dir', async () => {
    const save = vi.fn(async () => '/out/report');
    const t = setup({ save });
    await exportWithPandoc('latex', t.deps);
    expect(save).toHaveBeenCalledWith({ defaultPath: '/docs/doc.tex', filters: [{ name: 'LaTeX', extensions: ['tex'] }] });
    expect(t.pandocExport.mock.calls[0][1]).toBe('/out/report.tex');
    expect(withExtension('/a/b.TEX', 'tex')).toBe('/a/b.TEX');
  });

  it('rejection (pandoc not found / old / non-zero exit) clears progress and shows the message', async () => {
    for (const msg of ['Pandoc not found. Install it…', 'Pandoc 1.19 at /x is too old', 'Pandoc failed (exit status: 83):\nCould not find image']) {
      const t = setup();
      t.pandocExport.mockRejectedValueOnce(new Error(msg));
      expect(await settles(exportWithPandoc('docx', t.deps))).toBe(false);
      expect(t.progress()).toEqual({ open: 0, shown: 1 });
      expect(t.notices).toEqual([{ message: `Word export failed: ${msg}`, kind: 'error', action: undefined }]);
    }
  });

  it('non-Error rejections and synchronous throws still settle', async () => {
    const t1 = setup();
    t1.pandocExport.mockImplementationOnce(() => Promise.reject('plain string'));
    expect(await exportWithPandoc('docx', t1.deps)).toBe(false);
    expect(t1.notices[0].message).toBe('Word export failed: plain string');
    const t2 = setup();
    t2.pandocExport.mockImplementationOnce(() => {
      throw new Error('sync boom');
    });
    expect(await exportWithPandoc('epub', t2.deps)).toBe(false);
    expect(t2.progress().open).toBe(0);
    expect(t2.notices[0]).toMatchObject({ kind: 'error', message: 'EPUB export failed: sync boom' });
  });

  it('a backend that never answers is cut off by the watchdog', async () => {
    vi.useFakeTimers();
    try {
      const t = setup({ watchdogMs: 5_000 });
      t.pandocExport.mockImplementationOnce(() => new Promise<string>(() => {}));
      const p = exportWithPandoc('docx', t.deps);
      await vi.advanceTimersByTimeAsync(5_001);
      expect(await p).toBe(false);
      expect(t.progress().open).toBe(0);
      expect(t.notices[0].message).toContain('no response from Pandoc');
    } finally {
      vi.useRealTimers();
    }
  });

  it('default watchdog is longer than the backend timeout', async () => {
    vi.useFakeTimers();
    try {
      const t = setup({ timeoutMs: 1_000 });
      t.pandocExport.mockImplementationOnce(() => new Promise<string>(() => {}));
      const p = exportWithPandoc('docx', t.deps);
      await vi.advanceTimersByTimeAsync(1_500);
      expect(t.progress().open).toBe(1); // backend still has time to report its own timeout
      await vi.advanceTimersByTimeAsync(20_000);
      expect(await p).toBe(false);
      expect(t.progress().open).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('platform without pandoc support reports an error immediately', async () => {
    const t = setup();
    t.deps.platform = { saveFileDialog: async () => '/x.docx' };
    expect(await exportWithPandoc('docx', t.deps)).toBe(false);
    expect(t.progress().shown).toBe(0);
    expect(t.notices[0]).toMatchObject({ kind: 'error' });
  });

  it('a throwing progress notice does not block or wedge the export', async () => {
    const t = setup({
      progress: () => {
        throw new Error('no DOM');
      },
    });
    expect(await exportWithPandoc('docx', t.deps)).toBe(true);
    expect(t.notices[0].kind).toBe('success');
  });
});

describe('pandoc wiring', () => {
  it('maps menu actions', () => {
    expect(pandocFormatForAction('exportDocx')).toBe('docx');
    expect(pandocFormatForAction('exportLatex')).toBe('latex');
    expect(pandocFormatForAction('exportEpub')).toBe('epub');
    expect(pandocFormatForAction('exportPdf')).toBeNull();
  });

  it('settings: pandocPath defaults to auto and is trimmed', () => {
    expect(migrateSettings({}).pandocPath).toBe('');
    expect(migrateSettings({ pandocPath: ' /usr/local/bin/pandoc ' }).pandocPath).toBe('/usr/local/bin/pandoc');
    expect(migrateSettings({ pandocPath: 42 }).pandocPath).toBe('');
  });
});

describe('pandoc Abort + options (#90)', () => {
  it('Abort stops the export by id and ends silently', async () => {
    let abortBtn: (() => void) | undefined;
    let reject: (e: Error) => void = () => {};
    const pandocAbort = vi.fn(async (_id: string) => {
      reject(new Error('Export aborted'));
      return true;
    });
    const onAborted = vi.fn();
    const t = setup({
      onAborted,
      progress: (_m, abort) => {
        abortBtn = abort;
        return () => {};
      },
    });
    t.deps.platform.pandocAbort = pandocAbort;
    t.pandocExport.mockImplementationOnce(() => new Promise<string>((_, r) => (reject = r)));
    const p = exportWithPandoc('docx', t.deps);
    await Promise.resolve();
    await Promise.resolve();
    expect(abortBtn).toBeTypeOf('function');
    abortBtn!();
    expect(await p).toBe(false);
    const id = (t.pandocExport.mock.calls[0][2] as { exportId: string }).exportId;
    expect(id).toMatch(/^pandoc-/);
    expect(pandocAbort).toHaveBeenCalledWith(id);
    expect(onAborted).toHaveBeenCalledOnce();
    expect(t.notices).toEqual([]);
  });

  it('no Abort button without platform support', async () => {
    let got: unknown = 'unset';
    const t = setup({ progress: (_m, abort) => ((got = abort), () => {}) });
    await exportWithPandoc('docx', t.deps);
    expect(got).toBeUndefined();
    expect((t.pandocExport.mock.calls[0][2] as { exportId?: string }).exportId).toBeUndefined();
  });

  it('per-format options are passed through', async () => {
    const options = { referenceDoc: 'ref.docx', template: '', css: '', epubChapterLevel: 0, extraArguments: '--toc' };
    const t = setup({ options });
    await exportWithPandoc('docx', t.deps);
    expect((t.pandocExport.mock.calls[0][2] as { options: unknown }).options).toEqual(options);
  });
});
