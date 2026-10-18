import { ExternalChangeBanner } from './ui/extchange';
import type { EditorHandle, EditorSettings, ImageMenuAction, MenuAction, Platform } from '../contracts';
import type { Wiring } from './wiring';
import { COMMANDS, commandForKey, commandSpec, isCommandId, type CommandId } from './commands';
import { DocumentController, type DocState } from './document';
import { documentTitle, loadKatexCss, needsKatex } from './export';
import { ExportController, registerPandocExporters } from './export-actions';
import { DEFAULT_PRINT_SETUP, effectivePage, pageCss, type PrintSetup } from './export-settings';
import { confirmOverwriteDialog, openExportingSheet, openPageSetup } from './export-ui';
import { runImport, type ImportHost } from './import';
import { FindBar } from './findbar';
import { extras } from './platform-extras';
import { openPreferences } from './preferences';
import { DEFAULT_SETTINGS, migrateSettings, pushRecent, type MarginSettings } from './settings';
import { FileTree } from './sidebar/filetree';
import { OutlineView } from './sidebar/outline';
import { StatusBar } from './statusbar';
import { ThemeManager } from './themes';
import { themeLabel } from '../themes';
import { ask } from './ui/modal';
import { insertTableDialog } from './ui/table-dialog';
import { closePalette, isPaletteOpen, openPalette, type PaletteItem } from './ui/palette';
import { toast } from './ui/toast';
import { PANDOC_ACTIONS, type PandocFormat } from './export-pandoc';
import { closeContextMenu } from './ui/contextmenu';
import { EditorContextMenu } from './ctxmenu';
import { ImageUploader } from './upload-actions';
import { ImageFeature } from './images/feature';
import { debounce, h } from './util/dom';
import { fuzzyFilter, fuzzyMatch } from './util/fuzzy';
import { formatShortcut, isMac } from './util/keymap';
import { matchShortcut as nativeShortcut } from '../platform/shortcuts';
import { basename, dirname, displayPath, isAbsolute, isInside, isMarkdownPath, isUrlLike, relative, relativeFrom, resolveDocPath, stripExt } from './util/path';

const ZOOM_STEPS = [0.5, 0.67, 0.75, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3];

export interface StartOptions {
  /** Folder/file to show when nothing is restored (dev stub demo). */
  initialFolder?: string | null;
  initialFile?: string | null;
}

export class App {
  readonly platform: Platform;
  editor!: EditorHandle;
  doc!: DocumentController;
  exports!: ExportController;
  settings: MarginSettings = { ...DEFAULT_SETTINGS };
  themes: ThemeManager;
  folder: string | null = null;
  /** Folder shown because a lone file was opened (not persisted as lastFolder). */
  private implicitFolder = false;

  // DOM
  readonly root: HTMLElement;
  private titleEl!: HTMLElement;
  private sidebar!: HTMLElement;
  private editorHost!: HTMLElement;
  private uploader!: ImageUploader;
  private images!: ImageFeature;
  private syncImagesSoon = debounce(() => this.images.sync(), 300);
  private scroller!: HTMLElement;
  private tree!: FileTree;
  private outline!: OutlineView;
  private findbar!: FindBar;
  private status!: StatusBar;
  private tabs: Record<'files' | 'outline', HTMLButtonElement> = {} as never;

  private unwatchFolder: (() => void) | null = null;
  /** Non-blocking "changed on disk" prompt (#82). */
  private extBanner = new ExternalChangeBanner();
  private lastKeyAction: { id: string; t: number } | null = null;
  private saveSettingsSoon = debounce(() => void this.persistSettings(), 400);
  private refreshOutlineSoon = debounce(() => this.refreshOutline(), 250);
  private refreshFindSoon = debounce(() => this.findbar.refresh(), 150);
  private refreshStatsSoon = debounce(() => this.status.setStats(this.editor.getStats()), 200);
  private colorScheme: 'light' | 'dark' = 'light';

  constructor(private wiring: Wiring, mount: HTMLElement) {
    this.platform = wiring.platform;
    this.root = mount;
    this.themes = new ThemeManager(() => this.applyAppearance());
  }

  // ======================================================== startup

  async start(opts: StartOptions = {}): Promise<void> {
    try {
      this.settings = migrateSettings(await this.platform.loadSettings());
    } catch (e) {
      console.warn('[margin] settings unreadable, using defaults', e);
    }
    try {
      this.themes.setExtraThemes(await this.platform.listThemes());
    } catch {
      /* built-ins only */
    }
    document.documentElement.dataset.platform = isMac ? 'mac' : 'other';
    document.documentElement.dataset.shell = this.platform.kind;
    this.buildLayout();
    this.applyAppearance();
    this.applyLayoutSettings();

    this.editor = this.wiring.createEditor(this.editorHost, this.editorSettings());
    this.doc = new DocumentController({
      platform: this.platform,
      editor: this.editor,
      askUnsaved: (name, reason) => this.askUnsaved(name, reason),
      askReloadDirty: (name) => this.askReloadDirty(name),
      externalChange: (c) => this.extBanner.show(c),
      notify: (m, k) => void toast(m, { kind: k }),
      autoSave: () => ({ enabled: this.settings.autoSave, delay: this.settings.autoSaveDelay }),
      imageRule: () => this.settings.imageRule,
      willLoad: (p) => this.editor.updateSettings({ baseDir: p ? dirname(p) : null }),
      onState: (s) => this.onDocState(s),
      onOpened: (p) => this.onOpened(p),
      defaultDir: () => this.folder,
    });
    this.exports = this.createExports();
    // #80: "Upload Image" context menu + "Upload All Local Images" command.
    this.uploader = new ImageUploader({
      platform: this.platform,
      editor: () => this.editor,
      baseDir: () => this.doc.dir,
      settings: () => this.settings,
      notify: (m, k, action) => void toast(m, { kind: k, ...(action ? { action } : {}) }),
    });
    // #99: image rules, Format › Image, image context menu, typora-root-url.
    this.images = new ImageFeature({
      platform: extras(this.platform) as Platform & ReturnType<typeof extras>,
      editor: () => this.editor,
      editorRoot: () => this.editorHost,
      docPath: () => this.doc.path,
      settings: () => this.settings,
      uploader: this.uploader,
      notify: (m, k, action) => void toast(m, { kind: k, ...(action ? { action } : {}) }),
      saveAs: () => void this.doc.saveAs(),
      openImagePreferences: () => this.preferences('images'),
      resolveAsset: (src) => this.resolveAsset(src),
    });
    this.images.attach(this.editorHost);
    // #97: editor context menus (text, link, image, table, code, math, diagram, atomic blocks).
    new EditorContextMenu(
      {
        editor: () => this.editor,
        platform: this.platform,
        run: (id) => this.run(id),
        openLink: (href) => void this.openLink(href),
        baseDir: () => this.doc.dir,
        uploadImage: (src) => void this.uploader.uploadSrcs([src]),
        notify: (m, k) => void toast(m, { kind: k }),
      },
      this.editorHost,
    ).attach();
    this.editor.onChange(() => {
      this.syncImagesSoon();
      this.refreshFindSoon();
      this.refreshOutlineSoon();
      this.refreshStatsSoon();
    });
    let selRaf = 0;
    this.editor.onSelectionChange(() => {
      cancelAnimationFrame(selRaf);
      selRaf = requestAnimationFrame(() => this.outline.setActive(this.editor.getActiveHeadingId()));
    });

    this.installKeys();
    this.platform.onMenu((a) => this.onMenu(a));
    this.platform.onOpenFiles((paths) => void this.openPaths(paths));
    this.platform.onCloseRequested(async () => {
      await this.doc.flushAutoSave();
      const ok = await this.doc.confirmLeave('before closing the window');
      if (ok) await this.persistSettings();
      return ok;
    });
    window.addEventListener('blur', () => void this.doc.flushAutoSave());

    // Initial content
    const folder =
      (this.settings.restoreLastFolder && this.settings.lastFolder) || opts.initialFolder || null;
    if (folder) await this.openFolder(folder, { quiet: true });
    if (opts.initialFile && (await this.platform.stat(opts.initialFile))) await this.doc.open(opts.initialFile);
    else this.onDocState(this.doc.state());
    this.refreshOutline();
    this.status.setStats(this.editor.getStats());
    this.status.setSource(this.editor.isSourceMode());
    this.root.classList.add('ready');
  }

  private editorSettings(): EditorSettings {
    return {
      baseDir: null,
      resolveAsset: (src) => this.resolveAsset(src),
      storeImage: (input) => this.storeImage(input),
      openLink: (href) => void this.openLink(href),
      ...(this.platform.writeClipboardRich ? { writeClipboardRich: (d) => this.platform.writeClipboardRich!(d) } : {}),
      ...(this.platform.readClipboard ? { readClipboard: () => this.platform.readClipboard!() } : {}),
      spellcheck: this.settings.spellcheck,
      focusMode: this.settings.focusMode,
      typewriterMode: this.settings.typewriterMode,
      colorScheme: this.colorScheme,
    };
  }

  // ======================================================== layout

  private buildLayout(): void {
    this.titleEl = h('span.title-text', { text: 'Untitled' });
    const titlebar = h('header.titlebar', { 'data-tauri-drag-region': '' }, h('div.title', { 'data-tauri-drag-region': '' }, this.titleEl));

    this.tree = new FileTree({
      platform: this.platform,
      openFile: (p) => void this.doc.open(p),
      onRenamed: (from, to) => {
        this.doc.renamed(from, to);
        this.settings.recentFiles = this.settings.recentFiles.map((r) => (isInside(from, r) ? to + r.slice(from.length) : r));
        this.saveSettingsSoon();
      },
      onDeleted: () => undefined,
      notify: (m, k) => void toast(m, { kind: k }),
      openFolderDialog: () => void this.run('openFolder'),
      openFolder: (p) => void this.openFolder(p),
      recentFolders: () => this.settings.recentFolders,
    });
    this.outline = new OutlineView((id) => {
      this.caretToBlock(id);
      this.editor.scrollToHeading(id);
      this.outline.setActive(id);
    });

    const tab = (id: 'files' | 'outline', label: string): HTMLButtonElement =>
      (this.tabs[id] = h('button.sidebar-tab', {
        type: 'button',
        role: 'tab',
        'data-tab': id,
        text: label,
        onclick: () => this.showSidebarTab(id),
      }));
    const resizer = h('div.sidebar-resizer', { role: 'separator', 'aria-orientation': 'vertical', 'aria-label': 'Resize sidebar' });
    this.sidebar = h(
      'aside.sidebar',
      { 'aria-label': 'Sidebar' },
      h('nav.sidebar-tabs', { role: 'tablist' }, tab('files', 'Files'), tab('outline', 'Outline')),
      h('div.sidebar-panel', { 'data-panel': 'files' }, this.tree.el),
      h('div.sidebar-panel', { 'data-panel': 'outline' }, this.outline.el),
      resizer,
    );
    this.installResizer(resizer);

    this.findbar = new FindBar(() => this.editor);
    this.editorHost = h('div.margin-doc.editor-host');
    this.scroller = h('div.editor-scroll', null, h('div.editor-page', null, this.editorHost));
    this.scroller.addEventListener('mousedown', (e) => {
      // Clicking the empty margin below/around the page focuses the editor.
      if (e.target === this.scroller || (e.target as HTMLElement).classList.contains('editor-page')) {
        e.preventDefault();
        this.editor.focus();
      }
    });
    const main = h('main.main', null, this.findbar.el, this.extBanner.el, this.scroller);

    this.status = new StatusBar({
      toggleSidebar: () => void this.run('toggleSidebar'),
      toggleSource: () => void this.run('toggleSource'),
      toggleEol: () => void this.run('toggleLineEnding'),
    });

    this.root.replaceChildren(titlebar, h('div.workspace', null, this.sidebar, main), this.status.el);
  }

  private installResizer(handle: HTMLElement): void {
    handle.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      handle.setPointerCapture(e.pointerId);
      const startX = e.clientX;
      const startW = this.settings.sidebarWidth;
      this.root.classList.add('resizing');
      const move = (ev: PointerEvent): void => {
        const w = Math.max(180, Math.min(520, startW + ev.clientX - startX));
        this.settings.sidebarWidth = w;
        this.root.style.setProperty('--sidebar-width', `${w}px`);
      };
      const up = (): void => {
        handle.removeEventListener('pointermove', move);
        handle.removeEventListener('pointerup', up);
        this.root.classList.remove('resizing');
        this.saveSettingsSoon();
      };
      handle.addEventListener('pointermove', move);
      handle.addEventListener('pointerup', up);
    });
    handle.addEventListener('dblclick', () => {
      this.settings.sidebarWidth = DEFAULT_SETTINGS.sidebarWidth;
      this.applyLayoutSettings();
      this.saveSettingsSoon();
    });
  }

  private applyLayoutSettings(): void {
    const s = this.settings;
    this.root.style.setProperty('--sidebar-width', `${s.sidebarWidth}px`);
    this.root.classList.toggle('sidebar-hidden', !s.sidebarVisible);
    this.sidebar.setAttribute('aria-hidden', String(!s.sidebarVisible));
    for (const [id, btn] of Object.entries(this.tabs)) btn.setAttribute('aria-selected', String(id === s.sidebarTab));
    this.sidebar.dataset.tab = s.sidebarTab;
    this.root.classList.toggle('focus-mode', s.focusMode);
    this.root.classList.toggle('typewriter-mode', s.typewriterMode);
    this.status?.setModes({ focus: s.focusMode, typewriter: s.typewriterMode });
    document.documentElement.style.setProperty('zoom', s.zoom === 1 ? '' : String(s.zoom));
  }

  private applyAppearance(): void {
    const { dark } = this.themes.apply(this.settings);
    const scheme = dark ? 'dark' : 'light';
    if (scheme !== this.colorScheme) {
      this.colorScheme = scheme;
      this.editor?.updateSettings({ colorScheme: scheme });
    }
  }

  private showSidebarTab(id: 'files' | 'outline'): void {
    this.updateSettings({ sidebarTab: id, sidebarVisible: true });
    if (id === 'outline') this.refreshOutline();
  }

  private refreshOutline(): void {
    this.outline.update(this.editor.getOutline());
    this.outline.setActive(this.editor.getActiveHeadingId());
  }

  // ======================================================== settings

  updateSettings(patch: Partial<MarginSettings>): void {
    const prev = this.settings;
    this.settings = migrateSettings({ ...prev, ...patch });
    const s = this.settings;
    if (s.theme !== prev.theme || s.darkTheme !== prev.darkTheme || s.colorScheme !== prev.colorScheme || s.customCss !== prev.customCss || s.fontSize !== prev.fontSize)
      this.applyAppearance();
    const ed: Partial<EditorSettings> = {};
    if (s.spellcheck !== prev.spellcheck) ed.spellcheck = s.spellcheck;
    if (s.focusMode !== prev.focusMode) ed.focusMode = s.focusMode;
    if (s.typewriterMode !== prev.typewriterMode) ed.typewriterMode = s.typewriterMode;
    if (Object.keys(ed).length) this.editor.updateSettings(ed);
    this.applyLayoutSettings();
    this.saveSettingsSoon();
  }

  private async persistSettings(): Promise<void> {
    this.saveSettingsSoon.cancel();
    try {
      await this.platform.saveSettings(this.settings);
    } catch (e) {
      console.warn('[margin] could not save settings', e);
    }
  }

  // ======================================================== documents

  private onDocState(s: DocState): void {
    const title = `${s.dirty ? '• ' : ''}${s.name}`;
    this.titleEl.textContent = s.path ? stripExt(s.name) : s.name;
    this.titleEl.title = s.path ?? '';
    this.root.classList.toggle('doc-dirty', s.dirty);
    void this.platform.setTitle(s.path && this.folder ? `${title} — ${basename(this.folder)}` : title);
    void this.platform.setDocumentEdited(s.dirty);
    this.status.setEol(s.eol);
    if (s.missing) this.status.setSaveState('Deleted on disk', 'missing');
    else if (s.dirty) this.status.setSaveState(this.settings.autoSave && s.path ? 'Saving…' : 'Edited', 'dirty');
    else if (s.savedAt) this.status.setSaveState('Saved', 'saved');
    else this.status.setSaveState('');
    this.tree.setActive(s.path);
    this.refreshOutlineSoon();
    this.refreshStatsSoon();
  }

  private onOpened(path: string): void {
    this.settings.recentFiles = pushRecent(this.settings.recentFiles, path);
    this.saveSettingsSoon();
    if (!this.folder || (this.implicitFolder && !isInside(this.folder, path))) {
      void this.openFolder(dirname(path), { implicit: true, quiet: true });
    } else if (isInside(this.folder, path)) {
      void this.tree.reveal(path);
    }
  }

  async openFolder(path: string, opts: { implicit?: boolean; quiet?: boolean } = {}): Promise<void> {
    const st = await this.platform.stat(path).catch(() => null);
    if (!st || !st.isDir) {
      if (!opts.quiet) toast(`Folder not found: ${displayPath(path)}`, { kind: 'error' });
      if (this.settings.lastFolder === path) this.updateSettings({ lastFolder: null });
      return;
    }
    this.folder = path;
    this.implicitFolder = !!opts.implicit;
    this.unwatchFolder?.();
    this.unwatchFolder = null;
    await this.tree.setRoot(path);
    if (this.doc.path) await this.tree.reveal(this.doc.path);
    try {
      const un = await this.platform.watch(path, (evs) => this.tree.onFsEvents(evs));
      if (this.folder === path) this.unwatchFolder = un;
      else un();
    } catch {
      /* best effort */
    }
    if (!opts.implicit) {
      this.updateSettings({ lastFolder: path, recentFolders: pushRecent(this.settings.recentFolders, path) });
    }
    this.onDocState(this.doc.state());
  }

  private async openPaths(paths: string[]): Promise<void> {
    let opened = false;
    for (const p of paths) {
      const st = await this.platform.stat(p).catch(() => null);
      if (st?.isDir) await this.openFolder(p);
      else if (!opened && st) opened = await this.doc.open(p);
    }
  }

  private askUnsaved(name: string, _reason: string): Promise<'save' | 'discard' | 'cancel'> {
    return ask({
      title: `Do you want to save the changes you made to “${name}”?`,
      message: 'Your changes will be lost if you don’t save them.',
      buttons: [
        { id: 'discard', label: 'Don’t Save', danger: true },
        { id: 'cancel', label: 'Cancel' },
        { id: 'save', label: 'Save', primary: true },
      ],
      cancelId: 'cancel',
    });
  }

  private async askReloadDirty(name: string): Promise<boolean> {
    const r = await ask({
      title: `“${name}” was changed by another application`,
      message: 'You have unsaved edits. Reload the version on disk and discard them, or keep editing your version?',
      buttons: [
        { id: 'keep', label: 'Keep My Version' },
        { id: 'reload', label: 'Reload From Disk', primary: true },
      ],
      cancelId: 'keep',
    });
    return r === 'reload';
  }

  /**
   * Put the caret at the end of block `id`'s text (outline jumps), so the active heading
   * and further typing follow the jump. DOM-level: the contract has no caret API.
   */
  private caretToBlock(id: string): void {
    if (this.editor.isSourceMode()) return;
    const content = this.editorHost.querySelector<HTMLElement>(`[data-bid="${CSS.escape(id)}"] .md-content`);
    const root = content?.closest<HTMLElement>('.md-editor');
    if (!content || !root) return;
    root.focus({ preventScroll: true });
    const r = document.createRange();
    r.selectNodeContents(content);
    r.collapse(false);
    const sel = getSelection();
    sel?.removeAllRanges();
    sel?.addRange(r);
  }

  // ======================================================== assets & links

  private allowedAssetDirs = new Set<string>();

  /** While rendering an HTML export: directory of the output file (srcs become relative to it). */
  private exportDir: string | null = null;
  /** File › Page Setup (session only, like Typora's shared print info). */
  private printSetup: PrintSetup = { ...DEFAULT_PRINT_SETUP };

  private resolveAsset(src: string): string {
    const rooted = this.images?.resolvePath(src);
    const p = rooted !== undefined ? rooted : resolveDocPath(src, this.doc?.dir ?? null);
    if (!p) return src;
    if (this.exportDir && isAbsolute(src.trim())) return src; // absolute paths stay absolute
    if (this.exportDir) return encodeURI(relativeFrom(this.exportDir, p)).replace(/[?#]/g, encodeURIComponent);
    // Desktop serves asset:// only from opened folders; whitelist other image dirs.
    const dir = dirname(p);
    const inside = (this.folder && isInside(this.folder, p)) || (this.doc?.dir && isInside(this.doc.dir, p));
    if (!inside && !this.allowedAssetDirs.has(dir)) {
      this.allowedAssetDirs.add(dir);
      void this.platform.allowAssetDir(dir).catch(() => undefined);
    }
    return this.platform.assetUrl(p);
  }

  private storeImage(input: { bytes?: Uint8Array; mime?: string; path?: string; name?: string }): Promise<string | null> {
    return this.images.store(input);
  }

  private async openLink(href: string): Promise<void> {
    if (href.startsWith('#')) {
      const slug = decodeURIComponent(href.slice(1)).toLowerCase();
      const hd = this.editor.getOutline().find((x) => x.text.toLowerCase().replace(/\s+/g, '-') === slug || x.text.toLowerCase() === slug);
      if (hd) this.editor.scrollToHeading(hd.id);
      return;
    }
    if (!isUrlLike(href)) {
      const p = resolveDocPath(href, this.doc.dir);
      if (p && isMarkdownPath(p)) {
        await this.doc.open(p);
        return;
      }
      if (p) {
        await extras(this.platform).revealInFolder?.(p);
        return;
      }
    }
    await this.platform.openExternal(href);
  }

  // ======================================================== commands

  private installKeys(): void {
    window.addEventListener(
      'keydown',
      (e) => {
        if (e.isComposing || e.key === 'Process') return;
        if (e.key === 'Escape' && this.findbar.isOpen && !isPaletteOpen() && !document.querySelector('.modal-backdrop, .context-menu')) {
          e.preventDefault();
          this.findbar.close();
          return;
        }
        const spec = commandForKey(e);
        if (!spec) return;
        // Keys owned by the native menu (emulated by WebPlatform in the browser) reach us
        // through platform.onMenu; only handle app-only keys or ones the app maps differently.
        if (nativeShortcut(e) === spec.id || spec.passthrough) return;
        if (document.querySelector('.modal-backdrop')) return;
        if (spec.scope === 'editor' && !this.focusInEditor()) return;
        e.preventDefault();
        e.stopImmediatePropagation();
        this.lastKeyAction = { id: spec.id, t: performance.now() };
        void this.run(spec.id);
      },
      true,
    );
  }

  /** Paste as Plain Text (#96): the editor's own path, or plain text into a focused text field. */
  private async pastePlain(): Promise<boolean> {
    const a = document.activeElement;
    if (a instanceof HTMLInputElement || a instanceof HTMLTextAreaElement) {
      const t = await navigator.clipboard?.readText?.().catch(() => '');
      if (t) document.execCommand('insertText', false, t);
      return !!t;
    }
    return this.editor.exec({ kind: 'pastePlain' });
  }

  private focusInEditor(): boolean {
    const a = document.activeElement;
    return !a || a === document.body || this.editorHost.contains(a);
  }

  private onMenu(action: MenuAction): void {
    // A key we already handled in JS may also arrive as a menu action.
    const last = this.lastKeyAction;
    if (last && last.id === action && performance.now() - last.t < 250) return;
    if (!isCommandId(action)) return console.warn('[margin] unknown menu action', action);
    // Menu accelerators fire regardless of focus: keep editor commands out of the
    // find bar / palette / dialogs, and give their text fields native undo/redo.
    if (commandSpec(action)?.scope === 'editor' && !this.focusInEditor()) {
      const a = document.activeElement;
      if ((action === 'undo' || action === 'redo') && (a instanceof HTMLInputElement || a instanceof HTMLTextAreaElement)) {
        document.execCommand(action);
      }
      return;
    }
    if (document.querySelector('.modal-backdrop') && action !== 'preferences') return;
    void this.run(action);
  }

  /** Paragraph › Table › Insert Table… (#98): rows × columns dialog, then insert. */
  private async insertTable(): Promise<boolean> {
    const size = await insertTableDialog();
    if (!size) return false;
    this.editor.focus();
    return this.editor.exec({ kind: 'insertTable', rows: size.rows, cols: size.cols });
  }

  /** Dispatch any MenuAction / app command. Returns false when unhandled. */
  async run(id: CommandId): Promise<boolean> {
    closeContextMenu();
    const ed = this.editor;
    if (id.startsWith('heading:')) return ed.exec({ kind: 'heading', level: Number(id.slice(8)) as 0 });
    if (id.startsWith('mark:')) return ed.exec({ kind: 'mark', mark: id.slice(5) as 'strong' });
    if (id === 'block:table' || id === 'table:insert') return this.insertTable();
    if (id.startsWith('table:')) return ed.exec({ kind: 'table', op: id.slice(6) as 'copy' });
    if (id.startsWith('code:')) return ed.exec({ kind: 'code', op: id.slice(5) as 'copy' });
    if (id.startsWith('math:')) return ed.exec({ kind: 'math', op: id.slice(5) as 'copyTex' });
    if (id.startsWith('block:')) return ed.exec({ kind: 'block', block: id.slice(6) as 'quote' });
    if (id.startsWith('task:')) return ed.exec({ kind: 'task', op: id.slice(5) as 'toggle' });
    if (id === 'para:headingUp' || id === 'para:headingDown') return ed.exec({ kind: 'headingLevel', delta: id === 'para:headingUp' ? 1 : -1 });
    if (id === 'para:insertBefore' || id === 'para:insertAfter') return ed.exec({ kind: 'insertParagraph', where: id === 'para:insertBefore' ? 'before' : 'after' });
    if (id === 'clearFormat') return ed.exec({ kind: 'clearFormat' });
    if (id.startsWith('copyAs:')) return ed.exec({ kind: 'copyAs', format: id.slice(7) as 'markdown' });
    if (id.startsWith('select:')) return ed.exec({ kind: 'select', scope: id.slice(7) as 'word' });
    if (id.startsWith('delete:')) return ed.exec({ kind: 'delete', scope: id.slice(7) as 'word' });
    if (id.startsWith('jump:')) return ed.exec({ kind: 'jump', to: id.slice(5) as 'top' });
    if (id === 'pastePlain') return this.pastePlain();
    if (id.startsWith('image:')) return this.images.run(id.slice(6) as ImageMenuAction);
    if (id.startsWith('theme:')) {
      const name = id.slice(6);
      if (!(name in this.themes.themes)) return false;
      // Show the picked theme now; keep following the system only if it already agrees.
      const dark = this.themes.isDark(name);
      const cs = this.settings.colorScheme;
      const systemAgrees = cs === 'system' && this.themes.osDark === dark;
      const colorScheme = systemAgrees ? cs : dark ? 'dark' : 'light';
      this.updateSettings(dark ? { darkTheme: name, colorScheme } : { theme: name, colorScheme });
      return true;
    }
    switch (id) {
      case 'new':
        return this.doc.newDocument();
      case 'open':
        return this.doc.openDialog();
      case 'openFolder': {
        const p = await this.platform.openFileDialog({ directory: true });
        if (p) await this.openFolder(p);
        return !!p;
      }
      case 'save':
        return this.doc.save();
      case 'saveAs':
        return this.doc.saveAs();
      case 'close':
        return this.doc.close();
      case 'reloadFromDisk':
        await this.doc.reloadFromDisk();
        return true;
      case 'exportHtml':
      case 'exportPdf':
        return this.exports.export(id === 'exportHtml' ? 'html' : 'pdf');
      case 'exportHtmlPlain':
        return this.exports.export('html-plain');
      case 'exportImage':
        return this.exports.export('image');
      case 'exportPrevious':
        return this.exports.export(null, 'previous');
      case 'exportOverwrite':
        return this.exports.export(null, 'overwrite');
      case 'exportSettings':
        this.preferences('export');
        return true;
      case 'pageSetup': {
        const ps = await openPageSetup(this.printSetup);
        if (ps) {
          this.printSetup = ps;
          this.applyPrintPageCss();
        }
        return !!ps;
      }
      case 'exportDocx':
      case 'exportLatex':
      case 'exportEpub':
      case 'exportOdt':
      case 'exportRtf':
      case 'exportMediawiki':
      case 'exportRst':
      case 'exportTextile':
      case 'exportOpml':
        return this.exportPandoc(PANDOC_ACTIONS[id]);
      case 'exportCustom':
        this.customExportPalette();
        return true;
      case 'import':
        return runImport(this.importHost());
      case 'print':
        this.applyPrintPageCss();
        await this.platform.print();
        return true;
      case 'undo':
      case 'redo':
        return ed.exec({ kind: id });
      case 'find':
      case 'replace':
        this.findbar.open(id === 'replace');
        return true;
      case 'toggleSidebar':
        this.updateSettings({ sidebarVisible: !this.settings.sidebarVisible });
        return true;
      case 'showFiles':
      case 'showOutline': {
        const tab = id === 'showFiles' ? 'files' : 'outline';
        if (this.settings.sidebarVisible && this.settings.sidebarTab === tab) this.updateSettings({ sidebarVisible: false });
        else this.showSidebarTab(tab);
        return true;
      }
      case 'revealActiveFile':
        if (this.doc.path) {
          this.showSidebarTab('files');
          await this.tree.reveal(this.doc.path);
        }
        return true;
      case 'toggleSource': {
        const on = !ed.isSourceMode();
        ed.setSourceMode(on);
        this.status.setSource(on);
        this.root.classList.toggle('source-mode', on);
        ed.focus();
        return true;
      }
      case 'toggleFocus':
        this.updateSettings({ focusMode: !this.settings.focusMode });
        return true;
      case 'toggleTypewriter':
        this.updateSettings({ typewriterMode: !this.settings.typewriterMode });
        return true;
      case 'quickOpen':
        this.quickOpen();
        return true;
      case 'commandPalette':
        this.commandPalette();
        return true;
      case 'clearRecent':
        this.updateSettings({ recentFiles: [], recentFolders: [] });
        return true;
      case 'zoomIn':
      case 'zoomOut':
      case 'zoomReset': {
        const z = this.settings.zoom;
        const next =
          id === 'zoomReset'
            ? 1
            : id === 'zoomIn'
              ? (ZOOM_STEPS.find((s) => s > z + 0.001) ?? z)
              : ([...ZOOM_STEPS].reverse().find((s) => s < z - 0.001) ?? z);
        this.updateSettings({ zoom: next });
        toast(`Zoom ${Math.round(next * 100)}%`, { timeout: 1200 });
        return true;
      }
      case 'toggleLineEnding':
        this.doc.setEol(this.doc.eol === '\n' ? '\r\n' : '\n');
        return true;
      case 'preferences':
        this.preferences();
        return true;
      case 'openThemesFolder':
        await this.openThemesFolder();
        return true;
      case 'uploadAllImages':
        return (await this.uploader.uploadAll()).ok;
    }
    return false;
  }

  private preferences(section?: 'export' | 'files' | 'images'): void {
    openPreferences({
      settings: () => this.settings,
      update: (p) => this.updateSettings(p),
      themeNames: () => this.themes.names(),
      isDarkTheme: (n) => this.themes.isDark(n),
      openThemesFolder: () => void this.openThemesFolder(),
      pickFolder: () => this.platform.openFileDialog({ directory: true }),
      pickFile: (name, extensions) => this.platform.openFileDialog({ filters: [{ name, extensions }] }),
      detectPandoc: async (path) => {
        const detect = extras(this.platform).pandocDetect;
        if (!detect) return 'Pandoc export is only available in the desktop app.';
        try {
          const r = await detect.call(this.platform, path || null);
          return `Found pandoc ${r.version} at ${r.path}`;
        } catch (e) {
          return e instanceof Error ? e.message : String(e);
        }
      },
      testUploader: (config) => {
        const test = extras(this.platform).testUploader;
        return test ? test.call(this.platform, config) : Promise.reject(new Error('Image upload is only available in the desktop app.'));
      },
    }, section);
  }

  private async openThemesFolder(): Promise<void> {
    const dir = await this.platform.themesDir();
    const reveal = extras(this.platform).revealInFolder;
    if (reveal) await reveal.call(this.platform, dir);
    else toast(`Themes folder: ${dir}`, { timeout: 6000 });
  }

  // ======================================================== palettes

  private fileItem(path: string, query: string): PaletteItem | null {
    const rel = this.folder && isInside(this.folder, path) ? relative(this.folder, path) : displayPath(path);
    const name = basename(path);
    const dir = rel.length > name.length ? rel.slice(0, rel.length - name.length - 1) : '';
    const m = fuzzyMatch(query, rel);
    if (!m && query.trim()) return null;
    const off = rel.length - name.length;
    const hits = m?.indices ?? [];
    return {
      id: path,
      label: name,
      labelHits: hits.filter((i) => i >= off).map((i) => i - off),
      detail: dir,
      detailHits: hits.filter((i) => i < dir.length),
      kind: 'file',
    };
  }

  quickOpen(): void {
    if (isPaletteOpen()) closePalette();
    openPalette({
      className: 'quick-open',
      placeholder: this.folder ? `Search files in ${basename(this.folder)}` : 'Search recent files',
      emptyText: this.folder ? 'No matching files' : 'No recent files — open a folder to search it',
      provide: async (q) => {
        const recent = this.settings.recentFiles;
        let paths: string[];
        if (this.folder) {
          let found: string[] = [];
          try {
            found = await this.platform.quickOpen(this.folder, q, 50);
          } catch (e) {
            console.warn(e);
          }
          paths = q.trim() ? found : [...recent.filter((r) => isInside(this.folder!, r)), ...found];
        } else {
          paths = fuzzyFilter(q, recent, (p) => p).map((r) => r.item);
        }
        const seen = new Set<string>();
        const items: PaletteItem[] = [];
        for (const p of paths) {
          if (seen.has(p) || p === this.doc.path) continue;
          seen.add(p);
          const it = this.fileItem(p, q);
          if (it) items.push(it);
        }
        return items.slice(0, 50);
      },
      pick: (it) => void this.doc.open(it.id),
    });
  }

  commandPalette(): void {
    const items: { id: string; text: string; label: string; detail: string; hint?: string }[] = [];
    for (const c of COMMANDS) {
      items.push({ id: c.id, text: `${c.category}: ${c.label}`, label: `${c.category}: ${c.label}`, detail: '', hint: c.keys?.[0] ? formatShortcut(c.keys[0]) : undefined });
    }
    for (const n of this.themes.names()) {
      const active = this.themes.current === n;
      items.push({ id: `theme:${n}`, text: `Theme: ${themeLabel(n)}`, label: `Theme: ${themeLabel(n)}`, detail: active ? 'current' : '' });
    }
    for (const c of this.settings.export.custom) {
      items.push({ id: `custom:${c.id}`, text: `File: Export as ${c.name}`, label: `File: Export as ${c.name}`, detail: 'custom export' });
    }
    for (const p of this.settings.recentFiles) {
      items.push({ id: `recent:${p}`, text: `Open Recent: ${basename(p)}`, label: `Open Recent: ${basename(p)}`, detail: displayPath(dirname(p)) });
    }
    for (const p of this.settings.recentFolders) {
      items.push({ id: `folder:${p}`, text: `Open Recent Folder: ${basename(p)}`, label: `Open Recent Folder: ${basename(p)}`, detail: displayPath(p) });
    }
    openPalette({
      className: 'command-palette',
      placeholder: 'Type a command',
      provide: (q) =>
        fuzzyFilter(q, items, (x) => x.text, 80).map(({ item, match }) => ({
          id: item.id,
          label: item.label,
          labelHits: match.indices,
          detail: item.detail || undefined,
          hint: item.hint,
          kind: 'command',
        })),
      pick: (it) => {
        if (it.id.startsWith('custom:')) void this.exports.export(it.id);
        else if (it.id.startsWith('recent:')) void this.doc.open(it.id.slice(7));
        else if (it.id.startsWith('folder:')) void this.openFolder(it.id.slice(7));
        else if (isCommandId(it.id)) {
          // the palette took the DOM selection: put the editor's caret/selection back first
          if (commandSpec(it.id)?.scope === 'editor') this.editor.focus();
          void this.run(it.id);
        }
      },
    });
  }

  // ======================================================== export

  /** File › Export › Custom…: pick one of the user's export commands. */
  private customExportPalette(): void {
    const list = this.settings.export.custom;
    if (!list.length) {
      toast('No custom export commands yet — add one in Export Settings.', { kind: 'info', action: { label: 'Export Settings', run: () => this.preferences('export') } });
      return;
    }
    if (isPaletteOpen()) closePalette();
    openPalette({
      className: 'command-palette',
      placeholder: 'Export with…',
      provide: (q) =>
        fuzzyFilter(q, list, (c) => c.name, 50).map(({ item, match }) => ({ id: `custom:${item.id}`, label: item.name, labelHits: match.indices, detail: item.command, kind: 'command' })),
      pick: (it) => void this.exports.export(it.id),
    });
  }

  private importHost(): ImportHost {
    return {
      platform: this.platform,
      pandocPath: () => this.settings.pandocPath,
      openAsNew: (md) => this.doc.newDocument(md),
      progress: (m) => toast(m, { kind: 'info', timeout: 0 }),
      notify: (m, kind, action) => void toast(m, { kind, action }),
      htmlToMarkdown: async (html) => (await import('../editor/core/paste')).htmlToMarkdown(html),
      openPandocSettings: () => this.preferences('files'),
    };
  }

  private createExports(): ExportController {
    const c = new ExportController({
      platform: this.platform,
      exportSettings: () => this.settings.export,
      updateExportSettings: (next) => this.updateSettings({ export: next }),
      markdown: () => this.editor.getMarkdown(),
      docPath: () => this.doc.path,
      folder: () => this.folder,
      renderBody: (relativeTo) => {
        // HTML: local images as paths relative to the exported file (webview asset URLs don't
        // work outside the app). PDF/image keep asset URLs, which the renderer loads (#27).
        this.exportDir = relativeTo;
        try {
          return this.editor.renderHTML();
        } finally {
          this.exportDir = null;
        }
      },
      themeCss: (theme) => this.themes.exportCss(theme),
      extraCss: async (body) => `${await this.wiring.loadBlocksCss()}\n${needsKatex(body) ? await loadKatexCss() : ''}`,
      notify: (m, kind, action) => void toast(m, { kind, action }),
      confirmOverwrite: (p) => confirmOverwriteDialog(p),
      exportProgress: (abort) => openExportingSheet(abort),
      printSetup: () => this.printSetup,
    });
    registerPandocExporters(c, {
      pandocPath: () => this.settings.pandocPath,
      title: () => documentTitle(this.editor.getMarkdown(), this.doc.path ? basename(this.doc.path) : null),
      progress: (_m, abort) => openExportingSheet(abort),
    });
    return c;
  }

  /** Page Setup applies to File › Print: keep an @page rule in the live document. */
  private applyPrintPageCss(): void {
    let el = document.getElementById('margin-print-page') as HTMLStyleElement | null;
    if (!el) {
      el = document.createElement('style');
      el.id = 'margin-print-page';
      document.head.appendChild(el);
    }
    el.textContent = pageCss(effectivePage(this.settings.export.pdf.page, this.printSetup), this.settings.export.pdf.pageBreaks);
  }

  private exportPandoc(format: PandocFormat): Promise<boolean> {
    return this.exports.export(`pandoc:${format}`);
  }


  /** For tests / devtools. */
  get commandSpec(): typeof commandSpec {
    return commandSpec;
  }
}
