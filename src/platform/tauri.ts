import { convertFileSrc, invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { getCurrentWebviewWindow } from '@tauri-apps/api/webviewWindow';
import type { FileDrop, AppSettings, DirEntry, FsEvent, ImageRule, MenuAction, PdfExportOptions, Platform, RichClipboardData, ClipboardSnapshot, UploadConfig } from '../contracts';
import { builtinThemes, normalizeSettings, printHtmlInIframe, withPrintPageCss } from './common';

/** Event names emitted by `src-tauri/src/lib.rs`. */
const EV = {
  menu: 'margin://menu',
  fs: 'margin://fs-events',
  openFiles: 'margin://open-files',
  closeRequested: 'margin://close-requested',
  fileDrop: 'margin://file-drop',
} as const;

async function call<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  try {
    return await invoke<T>(cmd, args);
  } catch (e) {
    throw e instanceof Error ? e : new Error(String(e));
  }
}

/**
 * `listen()` is async; the contract wants a sync unsubscribe. Scoped to this window:
 * with several windows (#94) menu / open-files / close events go to one of them.
 */
function subscribe<T>(event: string, handler: (payload: T) => void): () => void {
  let unlisten: UnlistenFn | null = null;
  let cancelled = false;
  void getCurrentWebviewWindow().listen<T>(event, (e) => handler(e.payload)).then((u) => {
    if (cancelled) u();
    else unlisten = u;
  });
  return () => {
    cancelled = true;
    unlisten?.();
  };
}

export class TauriPlatform implements Platform {
  readonly kind = 'tauri' as const;
  private currentTheme = '';
  private closeHandlers = new Set<() => Promise<boolean>>();
  private closeUnlisten: (() => void) | null = null;
  private closing = false;

  readTextFile(path: string): Promise<string> {
    return call('read_text_file', { path });
  }

  writeTextFile(path: string, content: string): Promise<void> {
    return call('write_text_file', { path, content });
  }

  stat(path: string): Promise<DirEntry | null> {
    return call('stat', { path });
  }

  listDir(path: string): Promise<DirEntry[]> {
    return call('list_dir', { path });
  }

  async watch(path: string, cb: (events: FsEvent[]) => void): Promise<() => void> {
    // Subscribe first so no batch is lost between `watch` and `listen`.
    let id = -1;
    const early: { id: number; events: FsEvent[] }[] = [];
    const unlisten = await listen<{ id: number; events: FsEvent[] }>(EV.fs, (e) => {
      if (id < 0) early.push(e.payload);
      else if (e.payload.id === id) cb(e.payload.events);
    });
    try {
      id = await call<number>('watch', { path });
    } catch (e) {
      unlisten();
      throw e;
    }
    for (const p of early) if (p.id === id) cb(p.events);
    return () => {
      unlisten();
      void call('unwatch', { id }).catch(() => {});
    };
  }

  quickOpen(root: string, query: string, limit = 50): Promise<string[]> {
    return call('quick_open', { root, query, limit });
  }

  async storeImage(
    docPath: string | null,
    rule: ImageRule,
    input: { bytes?: Uint8Array; mime?: string; path?: string; name?: string },
  ): Promise<string> {
    if (input.bytes) {
      // Raw IPC body: no JSON number arrays for multi-MB screenshots.
      const meta = encodeURIComponent(JSON.stringify({ docPath, rule, mime: input.mime ?? null, name: input.name ?? null }));
      try {
        return await invoke<string>('store_image_bytes', input.bytes, { headers: { 'x-margin-meta': meta } });
      } catch (e) {
        throw e instanceof Error ? e : new Error(String(e));
      }
    }
    if (input.path) return call('store_image', { docPath, rule, path: input.path });
    throw new Error('storeImage: need bytes or path');
  }

  openFileDialog(opts?: { directory?: boolean; filters?: { name: string; extensions: string[] }[] }): Promise<string | null> {
    return call('open_dialog', { directory: !!opts?.directory, filters: opts?.filters ?? null });
  }

  saveFileDialog(opts?: { defaultPath?: string; filters?: { name: string; extensions: string[] }[] }): Promise<string | null> {
    return call('save_dialog', { defaultPath: opts?.defaultPath ?? null, filters: opts?.filters ?? null });
  }

  exportHtml(html: string, outPath: string): Promise<void> {
    return call('export_html', { html, outPath });
  }

  /**
   * macOS: paginated PDF via WebKit's print pipeline (hidden window). Relative
   * `src`s resolve against the output file's directory; asset URLs work as-is.
   * Other platforms: falls back to the system print dialog (user picks "Save as PDF").
   */
  async exportPdf(html: string, outPath: string, opts?: PdfExportOptions): Promise<void> {
    try {
      const { baseDir, ...options } = opts ?? {};
      await call('export_pdf', { html, outPath, baseDir: baseDir ?? null, options });
    } catch (e) {
      if (String((e as Error).message).startsWith('unsupported')) return printHtmlInIframe(withPrintPageCss(html, opts));
      throw e;
    }
  }

  // ---- optional Pandoc export (PlatformExtras, #81)
  pandocExport(
    markdown: string,
    outPath: string,
    opts: { format: string; docDir: string | null; title: string | null; pandocPath: string | null; timeoutMs: number; options?: object; exportId?: string },
  ): Promise<string> {
    return call('pandoc_export', { markdown, outPath, ...opts, options: opts.options ?? null, exportId: opts.exportId ?? null });
  }

  pandocAbort(exportId: string): Promise<boolean> {
    return call('pandoc_abort', { exportId });
  }

  pandocDetect(pandocPath: string | null): Promise<{ path: string; version: string }> {
    return call('pandoc_detect', { pandocPath });
  }

  // ---- optional image tools (PlatformExtras, #99 / #92)
  copyImage(src: string, dir: string, opts?: { name?: string; move?: boolean }): Promise<string> {
    return call('copy_image', { src, dir, name: opts?.name ?? null, mv: !!opts?.move });
  }

  imageScale(path: string): Promise<number> {
    return call('image_scale', { path });
  }

  openImagesDialog(): Promise<string[]> {
    return call('open_images_dialog', {});
  }

  testUploader(config: UploadConfig): Promise<{ ok: boolean; command: string; stdout: string; stderr: string; urls: string[]; message: string }> {
    return call('test_uploader', { config });
  }

  cancelUpload(): Promise<void> {
    return call('cancel_upload', {});
  }

  /**
   * After the first save of a document: copy images that were stored while it was
   * unsaved (`<app data>/images`, absolute srcs) under `rule`. Returns
   * `{ oldSrc: newSrc }`; rewrite those srcs in the document. Others are untouched.
   */
  relocateImages(docPath: string, rule: ImageRule, srcs: string[]): Promise<Record<string, string>> {
    return call('relocate_images', { docPath, rule, srcs });
  }

  /** Export › Image bytes (#95): raw IPC body, target path in a header. */
  exportBinary(bytes: Uint8Array, outPath: string): Promise<void> {
    return invoke('export_binary', bytes, { headers: { 'x-margin-path': encodeURIComponent(outPath) } }).then(
      () => undefined,
      (e: unknown) => {
        throw e instanceof Error ? e : new Error(String(e));
      },
    );
  }

  pandocImport(inputPath: string, pandocPath: string | null, timeoutMs: number): Promise<string> {
    return call('pandoc_import', { inputPath, pandocPath, timeoutMs });
  }

  runExportCommand(command: string, vars: Record<string, string>, stdin: string | null, cwd: string | null, timeoutMs: number, exportId?: string): Promise<{ stdout: string; stderr: string }> {
    return call('run_export_command', { command, vars, stdin, cwd, timeoutMs, exportId: exportId ?? null });
  }

  /** Open a file exported in this session with its default application. */
  openExportedFile(path: string): Promise<void> {
    return call('open_exported_file', { path });
  }

  // ---- optional file-tree operations (PlatformExtras, #21)
  rename(from: string, to: string): Promise<void> {
    return call('rename_path', { from, to });
  }

  /** Move to the Trash (never a hard delete). */
  remove(path: string): Promise<void> {
    return call('trash_path', { path });
  }

  createDir(path: string): Promise<void> {
    return call('create_dir', { path });
  }

  revealInFolder(path: string): Promise<void> {
    return call('reveal_path', { path });
  }

  /** #80: custom command (argv, no shell) or PicGo on 127.0.0.1; one URL per path. */
  uploadImages(paths: string[], config: UploadConfig): Promise<string[]> {
    return call('upload_images', { paths, config });
  }

  /** Let the webview load images from one more directory (non-recursive). */
  allowAssetDir(path: string): Promise<void> {
    return call('allow_asset_dir', { path });
  }

  /** Print the current window (system dialog). */
  print(): Promise<void> {
    return call('print_window');
  }

  async loadSettings(): Promise<AppSettings> {
    const s = normalizeSettings(await call<unknown>('load_settings'));
    this.currentTheme = s.theme;
    return s;
  }

  async saveSettings(s: AppSettings): Promise<void> {
    this.currentTheme = s.theme;
    await call('save_settings', { settings: s });
  }

  async listThemes(): Promise<Record<string, string>> {
    const user = await call<Record<string, string>>('list_themes').catch(() => ({}));
    const all = { ...builtinThemes(), ...user };
    void call('set_theme_menu', { names: Object.keys(all).sort(), current: this.currentTheme }).catch(() => {});
    return all;
  }

  themesDir(): Promise<string> {
    return call('themes_dir');
  }

  assetUrl(path: string): string {
    return convertFileSrc(path);
  }

  /** http(s)/mailto only; other schemes are refused natively. */
  /** #79: RTF onto the macOS pasteboard (no-op returning false on other OSes). */
  writeClipboardRich(data: RichClipboardData): Promise<boolean> {
    return call<boolean>('clipboard_write_rich', { data });
  }

  /** #96: general pasteboard plain/HTML (+ HTML from RTF); empty off macOS. */
  async readClipboard(): Promise<ClipboardSnapshot | null> {
    const r = await call<{ plain: string | null; html: string | null; rtf_html: string | null }>('clipboard_read');
    if (!r.plain && !r.html && !r.rtf_html) return null;
    return { plain: r.plain, html: r.html, rtfHtml: r.rtf_html };
  }

  openExternal(url: string): Promise<void> {
    return call('open_external', { url });
  }

  /** File › New Window / Open in New Window (#94). */
  openWindow(opts: { path?: string } = {}): Promise<void> {
    return call('open_window', { path: opts.path ?? null });
  }

  /** Raw bytes for Reopen with Encoding (#94). */
  async readFileBytes(path: string): Promise<Uint8Array> {
    const buf = await call<ArrayBuffer | number[]>('read_file_bytes', { path });
    return buf instanceof ArrayBuffer ? new Uint8Array(buf) : Uint8Array.from(buf);
  }

  /** Copy File Path: async clipboard API, falling back to a hidden textarea + execCommand. */
  async writeClipboardText(text: string): Promise<void> {
    try {
      await navigator.clipboard.writeText(text);
      return;
    } catch {
      /* not allowed without a user gesture in some webviews */
    }
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.cssText = 'position:fixed;opacity:0;top:0;left:0';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    if (!ok) throw new Error('clipboard unavailable');
  }

  setTitle(title: string): Promise<void> {
    return call('set_title', { title });
  }

  setDocumentEdited(edited: boolean): Promise<void> {
    return call('set_document_edited', { edited });
  }

  onMenu(cb: (action: MenuAction) => void): () => void {
    return subscribe<MenuAction>(EV.menu, cb);
  }

  onOpenFiles(cb: (paths: string[]) => void): () => void {
    const off = subscribe<string[]>(EV.openFiles, cb);
    // "Open in New Window" passes its file in the window URL (#94).
    const own = new URLSearchParams(location.search).getAll('open');
    if (own.length) queueMicrotask(() => cb(own));
    // Files passed before the frontend was listening (launch via Finder / CLI).
    else
      void call<string[]>('take_pending_open_files').then((paths) => {
        if (paths.length) cb(paths);
      });
    return off;
  }

  /** #23: Finder drops, intercepted natively (src-tauri/src/drop_macos.rs) so paths are known. */
  onFileDrop(cb: (drop: FileDrop) => void): () => void {
    return subscribe<FileDrop>(EV.fileDrop, cb);
  }

  /** #129: begin a native drag of `paths` from the current mouse gesture (sidebar rows). */
  startFileDrag(paths: string[]): void {
    if (paths.length) void call('start_file_drag', { paths }).catch(() => {});
  }

  onCloseRequested(cb: () => Promise<boolean>): () => void {
    this.closeHandlers.add(cb);
    if (!this.closeUnlisten) {
      this.closeUnlisten = subscribe<null>(EV.closeRequested, () => void this.runClose());
      void call('set_close_guard', { enabled: true });
    }
    return () => {
      this.closeHandlers.delete(cb);
      if (this.closeHandlers.size === 0 && this.closeUnlisten) {
        this.closeUnlisten();
        this.closeUnlisten = null;
        void call('set_close_guard', { enabled: false });
      }
    };
  }

  private async runClose(): Promise<void> {
    if (this.closing) return;
    this.closing = true;
    try {
      for (const h of [...this.closeHandlers]) {
        let ok = false;
        try {
          ok = await h();
        } catch (e) {
          console.error('onCloseRequested handler failed', e);
        }
        if (!ok) return;
      }
      await call('confirm_close');
    } finally {
      this.closing = false;
    }
  }
}
