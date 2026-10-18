import { convertFileSrc, invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import type { AppSettings, DirEntry, FsEvent, ImageRule, MenuAction, Platform, RichClipboardData } from '../contracts';
import { builtinThemes, normalizeSettings, printHtmlInIframe } from './common';

/** Event names emitted by `src-tauri/src/lib.rs`. */
const EV = {
  menu: 'margin://menu',
  fs: 'margin://fs-events',
  openFiles: 'margin://open-files',
  closeRequested: 'margin://close-requested',
} as const;

async function call<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  try {
    return await invoke<T>(cmd, args);
  } catch (e) {
    throw e instanceof Error ? e : new Error(String(e));
  }
}

/** `listen()` is async; the contract wants a sync unsubscribe. */
function subscribe<T>(event: string, handler: (payload: T) => void): () => void {
  let unlisten: UnlistenFn | null = null;
  let cancelled = false;
  void listen<T>(event, (e) => handler(e.payload)).then((u) => {
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

  openFileDialog(opts?: { directory?: boolean }): Promise<string | null> {
    return call('open_dialog', { directory: !!opts?.directory });
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
  async exportPdf(html: string, outPath: string, opts?: { baseDir?: string }): Promise<void> {
    try {
      await call('export_pdf', { html, outPath, baseDir: opts?.baseDir ?? null });
    } catch (e) {
      if (String((e as Error).message).startsWith('unsupported')) return printHtmlInIframe(html);
      throw e;
    }
  }

  /**
   * After the first save of a document: copy images that were stored while it was
   * unsaved (`<app data>/images`, absolute srcs) under `rule`. Returns
   * `{ oldSrc: newSrc }`; rewrite those srcs in the document. Others are untouched.
   */
  relocateImages(docPath: string, rule: ImageRule, srcs: string[]): Promise<Record<string, string>> {
    return call('relocate_images', { docPath, rule, srcs });
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

  openExternal(url: string): Promise<void> {
    return call('open_external', { url });
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
    // Files passed before the frontend was listening (launch via Finder / CLI).
    void call<string[]>('take_pending_open_files').then((paths) => {
      if (paths.length) cb(paths);
    });
    return off;
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
