import { ExternalChangeBanner } from './ui/extchange';
import type { EditorHandle, EditorSettings, MenuAction, Platform } from '../contracts';
import type { Wiring } from './wiring';
import { COMMANDS, commandForKey, commandSpec, isCommandId, type CommandId } from './commands';
import { DocumentController, type DocState } from './document';
import { DocTabs, type DocTab, type DocHostCallbacks } from './doctabs';
import { TabBar } from './tabs';
import { FileOps } from './fileops';
import { VersionStore } from './versions';
import { DraftStore, type Draft } from './drafts';
import { buildExportHtml, documentTitle, loadKatexCss, needsKatex } from './export';
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
import { closePalette, isPaletteOpen, openPalette, type PaletteItem } from './ui/palette';
import { toast } from './ui/toast';
import { handleFileDrop } from './filedrop';
import { exportWithPandoc, PANDOC_ACTIONS, type PandocFormat } from './export-pandoc';
import { closeContextMenu } from './ui/contextmenu';
import { ImageUploader } from './upload-actions';
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
  /** A secondary window (File › New Window): no folder restore, no draft recovery. */
  fresh?: boolean;
}

export class App {
  readonly platform: Platform;
  /** Open documents (tabs); `editor` / `doc` are the active one's (#94). */
  docs!: DocTabs;
  get editor(): EditorHandle {
    return this.docs.active.editor;
  }
  get doc(): DocumentController {
    return this.docs.active.doc;
  }
  settings: MarginSettings = { ...DEFAULT_SETTINGS };
  themes: ThemeManager;
  folder: string | null = null;
  /** Folder shown because a lone file was opened (not persisted as lastFolder). */
  private implicitFolder = false;

  // DOM
  readonly root: HTMLElement;
  private titleEl!: HTMLElement;
  private sidebar!: HTMLElement;
  private page!: HTMLElement;
  private uploader!: ImageUploader;
  private scroller!: HTMLElement;
  private tabBar!: TabBar;
  private tree!: FileTree;
  private outline!: OutlineView;
  private findbar!: FindBar;
  private status!: StatusBar;
  private tabs: Record<'files' | 'outline', HTMLButtonElement> = {} as never;

  private unwatchFolder: (() => void) | null = null;
  /** Non-blocking "changed on disk" prompt (#82). */
  private extBanner = new ExternalChangeBanner();
  /** File-menu operations, version history and draft recovery (#94). */
  versions!: VersionStore;
  drafts!: DraftStore;
  fileOps!: FileOps;
  private saveDraftsSoon = debounce(() => void this.saveDrafts(), 800);
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

    this.docs = new DocTabs({
      platform: this.platform,
      page: this.page,
      scroller: this.scroller,
      createEditor: (host, tab) => this.createTabEditor(host, tab),
      docHost: (tab) => this.docHost(tab),
      activated: (tab) => this.onTabActivated(tab),
      changed: () => this.renderTabs(),
      saveOnSwitch: () => this.settings.saveOnSwitch,
      notify: (m, k) => void toast(m, { kind: k }),
    });
    this.versions = new VersionStore(this.platform);
    this.drafts = new DraftStore(this.platform, opts.fresh ? `window-${Date.now().toString(36)}` : 'main');
    this.fileOps = new FileOps({
      platform: this.platform,
      docs: this.docs,
      versions: this.versions,
      drafts: this.drafts,
      renamed: (from, to) => this.fileRenamed(from, to),
    });
    // #80: "Upload Image" context menu + "Upload All Local Images" command.
    this.uploader = new ImageUploader({
      platform: this.platform,
      editor: () => this.editor,
      baseDir: () => this.doc.dir,
      settings: () => this.settings,
      notify: (m, k) => void toast(m, { kind: k }),
    });
    this.docs.newTab();

    this.installKeys();
    this.platform.onMenu((a) => this.onMenu(a));
    this.platform.onOpenFiles((paths) => void this.openPaths(paths));
    this.platform.onFileDrop?.((drop) =>
      void handleFileDrop(
        {
          platform: this.platform,
          editor: () => this.editor,
          editorHost: () => this.docs.active.host,
          docDir: () => this.doc.dir,
          storeImage: (input) => this.storeImage(input),
          openPaths: (paths) => this.openPaths(paths),
          notify: (m) => void toast(m, { kind: 'info' }),
        },
        drop,
      ),
    );
    this.platform.onCloseRequested(async () => {
      const ok = await this.docs.confirmAll('before closing the window');
      if (ok) {
        this.saveDraftsSoon.cancel();
        await this.drafts.save([]); // closed cleanly: nothing to recover
        // On Launch › Restore last closed files and folders (main window only).
        if (!opts.fresh) this.updateSettings({ lastOpenFiles: this.docs.tabs.map((t) => t.doc.path).filter((p): p is string => !!p) });
        await this.persistSettings();
      }
      return ok;
    });
    window.addEventListener('blur', () => void this.doc.flushAutoSave());
    // The native menu is shared by all windows: the focused one decides (#94).
    window.addEventListener('focus', () => this.syncFileItems(!!this.doc.path, true));

    // Initial content
    // General › On Launch (native-commands §2.2): new file / last folders / last files and
    // folders / a pinned folder; anything that fails to restore leaves the blank document.
    const launch = opts.fresh ? 'newFile' : this.settings.onLaunch;
    const launchFolder = launch === 'customFolder' ? this.settings.pinFolder : launch === 'newFile' ? null : this.settings.lastFolder;
    const folder = launchFolder || opts.initialFolder || null;
    if (folder) await this.openFolder(folder, { quiet: true });
    if (opts.initialFile && (await this.platform.stat(opts.initialFile))) await this.docs.openPath(opts.initialFile, 'replace');
    else if (launch === 'restoreFilesAndFolders' && this.settings.lastOpenFiles.length) {
      for (const p of this.settings.lastOpenFiles) if (await this.platform.stat(p).catch(() => null)) await this.docs.openPath(p, 'tab');
      this.onDocState(this.doc.state());
    } else this.onDocState(this.doc.state());
    this.refreshOutline();
    this.status.setStats(this.editor.getStats());
    this.status.setSource(this.editor.isSourceMode());
    this.root.classList.add('ready');
    if (!opts.fresh) void this.offerDrafts();
  }

  /** One editor per tab; chrome refreshes only follow the active one. */
  private createTabEditor(host: HTMLElement, tab: DocTab): EditorHandle {
    const ed = this.wiring.createEditor(host, this.editorSettings(tab));
    this.uploader.attachContextMenu(host); // per tab: the editor host is where image menus start
    ed.onChange(() => {
      if (tab.doc?.dirty) this.saveDraftsSoon();
      if (this.docs.active !== tab) return;
      this.refreshFindSoon();
      this.refreshOutlineSoon();
      this.refreshStatsSoon();
    });
    let selRaf = 0;
    ed.onSelectionChange(() => {
      if (this.docs.active !== tab) return;
      cancelAnimationFrame(selRaf);
      selRaf = requestAnimationFrame(() => this.outline.setActive(ed.getActiveHeadingId()));
    });
    return ed;
  }

  private docHost(tab: DocTab): DocHostCallbacks {
    const front = (): void => {
      if (this.docs.active !== tab) this.docs.activate(tab);
    };
    return {
      askUnsaved: (name, reason) => (front(), this.askUnsaved(name, reason)),
      askReloadDirty: (name) => (front(), this.askReloadDirty(name)),
      externalChange: (c) => {
        tab.ext = c;
        if (this.docs.active === tab) this.extBanner.show(c);
      },
      notify: (m, k) => void toast(m, { kind: k }),
      autoSave: () => ({ enabled: this.settings.autoSave, delay: this.settings.autoSaveDelay }),
      imageRule: () => this.settings.imageRule,
      willLoad: (p) => tab.editor.updateSettings({ baseDir: p ? dirname(p) : null }),
      onState: (s) => {
        if (this.docs.active === tab) this.onDocState(s);
        this.renderTabs();
        this.saveDraftsSoon();
      },
      onOpened: (p) => {
        this.onOpened(p);
        void this.versions.record(p, tab.doc.savedText, { quiet: false });
      },
      onSaved: (p, text, quiet) => void this.versions.record(p, text, { quiet }),
      askCreateMissing: (p) => this.askCreateMissing(p),
      willLoadText: (_p, text) => this.degradeLarge(tab, text),
      defaultDir: () => this.folder,
    };
  }

  /** A file we track was renamed or moved (sidebar or File › Rename / Move To). */
  private fileRenamed(from: string, to: string): void {
    for (const t of this.docs.tabs) t.doc.renamed(from, to);
    this.settings.recentFiles = this.settings.recentFiles.map((r) => (isInside(from, r) ? to + r.slice(from.length) : r));
    this.saveSettingsSoon();
    if (this.folder && isInside(this.folder, to)) void this.tree.reveal(to);
    void this.versions.moved(from, to);
  }

  private async askCreateMissing(path: string): Promise<boolean> {
    const r = await ask({
      title: 'File does not exist',
      message: `File does not exist at ${displayPath(path)}. Do you want to create one at that path?`,
      buttons: [
        { id: 'cancel', label: 'Cancel' },
        { id: 'create', label: 'Create', primary: true },
      ],
      cancelId: 'cancel',
    });
    if (r !== 'create' && this.settings.recentFiles.includes(path)) {
      this.updateSettings({ recentFiles: this.settings.recentFiles.filter((x) => x !== path) });
    }
    return r === 'create';
  }

  /** Oversize documents open in source code mode (#94, Typora's "oversize" mode). */
  private degradeLarge(tab: DocTab, text: string): void {
    const size = new Blob([text]).size;
    if (size <= this.settings.largeFileBytes) return;
    if (!tab.editor.isSourceMode()) tab.editor.setSourceMode(true);
    if (this.docs.active === tab) {
      this.status.setSource(true);
      this.root.classList.add('source-mode');
    }
    toast(`This document is large (${(size / 1024 / 1024).toFixed(1)} MB), so it opened in source code mode.`, { kind: 'warning', timeout: 6000 });
  }

  /** Snapshot every modified document for crash recovery. */
  private async saveDrafts(): Promise<void> {
    const drafts: Draft[] = [];
    for (const t of this.docs.tabs) {
      if (!t.doc.dirty) continue;
      const content = t.editor.getMarkdown();
      if (!t.doc.path && !content.trim()) continue;
      drafts.push({ path: t.doc.path, name: t.doc.name, content, time: Date.now() });
    }
    await this.drafts.save(drafts);
  }

  /** Main window start: drafts left by a window that didn't close cleanly. */
  private async offerDrafts(): Promise<void> {
    const slots = await this.drafts.leftovers();
    this.fileOps.pendingDrafts = slots;
    const n = slots.reduce((a, s) => a + s.drafts.length, 0);
    if (!n) return;
    toast(`${n} unsaved draft${n > 1 ? 's' : ''} from the last session can be recovered.`, {
      kind: 'warning',
      timeout: 15000,
      action: { label: 'Recover…', run: () => void this.fileOps.recoverDrafts() },
    });
  }

  private onTabActivated(tab: DocTab): void {
    const src = tab.editor.isSourceMode();
    this.status.setSource(src);
    this.root.classList.toggle('source-mode', src);
    this.extBanner.show(tab.ext);
    this.onDocState(tab.doc.state());
    this.refreshOutline();
    this.status.setStats(tab.editor.getStats());
    this.findbar.refresh();
  }

  private renderTabs(): void {
    if (!this.docs?.active) return;
    this.tabBar.render(this.docs.views(), this.docs.active.id);
    this.root.classList.toggle('has-tabs', this.docs.tabs.length > 1);
  }

  private editorSettings(tab?: DocTab): EditorSettings {
    return {
      baseDir: null,
      resolveAsset: (src) => this.resolveAsset(src, tab),
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
      openFile: (p) => void this.docs.openPath(p, 'replace'),
      openInNewTab: (p) => void this.docs.openPath(p, 'tab'),
      openInNewWindow: (p) => void this.newWindow(p),
      onRenamed: (from, to) => this.fileRenamed(from, to),
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
    this.page = h('div.editor-page');
    this.scroller = h('div.editor-scroll', null, this.page);
    this.tabBar = new TabBar({
      activate: (id) => {
        const t = this.docs.byId(id);
        if (t) this.docs.activate(t);
      },
      close: (id) => {
        const t = this.docs.byId(id);
        if (t) void this.docs.close(t);
      },
      newTab: () => void this.run('newTab'),
      move: (id, to) => this.docs.move(id, to),
    });
    this.scroller.addEventListener('mousedown', (e) => {
      // Clicking the empty margin below/around the page focuses the editor.
      if (e.target === this.scroller || (e.target as HTMLElement).classList.contains('editor-page')) {
        e.preventDefault();
        this.editor.focus();
      }
    });
    const main = h('main.main', null, this.tabBar.el, this.findbar.el, this.extBanner.el, this.scroller);

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
      for (const ed of this.docs?.editors() ?? []) ed.updateSettings({ colorScheme: scheme });
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
    if (Object.keys(ed).length) for (const e of this.docs.editors()) e.updateSettings(ed);
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

  private fileItemsEnabled: boolean | null = null;
  /** Untitled documents grey out Rename/Move/Revert/Versions/Reveal/Copy Path/Properties (#94). */
  private syncFileItems(enabled: boolean, force = false): void {
    if (!force && enabled === this.fileItemsEnabled) return;
    this.fileItemsEnabled = enabled;
    void extras(this.platform).setFileItemsEnabled?.call(this.platform, enabled).catch(() => undefined);
  }

  private onDocState(s: DocState): void {
    const title = `${s.dirty ? '• ' : ''}${s.name}`;
    this.titleEl.textContent = s.path ? stripExt(s.name) : s.name;
    this.titleEl.title = s.path ?? '';
    this.root.classList.toggle('doc-dirty', s.dirty);
    void this.platform.setTitle(s.path && this.folder ? `${title} — ${basename(this.folder)}` : title);
    void this.platform.setDocumentEdited(s.dirty);
    this.syncFileItems(!!s.path);
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
      else if (st) opened = (await this.docs.openPath(p, 'tab')) || opened;
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
    const content = this.page.querySelector<HTMLElement>(`[data-bid="${CSS.escape(id)}"] .md-content`);
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

  private resolveAsset(src: string, tab?: DocTab): string {
    const doc = tab?.doc ?? this.docs?.active?.doc;
    const p = resolveDocPath(src, doc?.dir ?? null);
    if (!p) return src;
    if (this.exportDir && isAbsolute(src.trim())) return src; // absolute paths stay absolute
    if (this.exportDir) return encodeURI(relativeFrom(this.exportDir, p)).replace(/[?#]/g, encodeURIComponent);
    // Desktop serves asset:// only from opened folders; whitelist other image dirs.
    const dir = dirname(p);
    const inside = (this.folder && isInside(this.folder, p)) || (doc?.dir && isInside(doc.dir, p));
    if (!inside && !this.allowedAssetDirs.has(dir)) {
      this.allowedAssetDirs.add(dir);
      void this.platform.allowAssetDir(dir).catch(() => undefined);
    }
    return this.platform.assetUrl(p);
  }

  private async storeImage(input: { bytes?: Uint8Array; mime?: string; path?: string; name?: string }): Promise<string | null> {
    const rule = this.settings.imageRule;
    try {
      return await this.platform.storeImage(this.doc.path, rule, input);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (!this.doc.path && rule.kind === 'relative') {
        if (input.path) return input.path; // keep the original file until saved
        toast('Save the document first so pasted images can be stored next to it.', {
          kind: 'warning',
          action: { label: 'Save As…', run: () => void this.doc.saveAs() },
        });
      } else toast(`Couldn't insert image: ${msg}`, { kind: 'error' });
      return null;
    }
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
        await this.docs.openPath(p, 'replace');
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
    return !a || a === document.body || this.page.contains(a);
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

  /** Dispatch any MenuAction / app command. Returns false when unhandled. */
  async run(id: CommandId): Promise<boolean> {
    closeContextMenu();
    const ed = this.editor;
    if (id.startsWith('heading:')) return ed.exec({ kind: 'heading', level: Number(id.slice(8)) as 0 });
    if (id.startsWith('mark:')) return ed.exec({ kind: 'mark', mark: id.slice(5) as 'strong' });
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
      case 'newTab':
        if (id === 'new' && this.doc.isPristine()) this.editor.focus();
        else this.docs.newTab().editor.focus();
        return true;
      case 'open': {
        const p = await this.platform.openFileDialog();
        return p ? this.docs.openPath(p, 'tab') : false;
      }
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
        return this.docs.close();
      case 'nextTab':
      case 'prevTab':
        this.docs.cycle(id === 'nextTab' ? 1 : -1);
        return true;
      case 'reopenClosed':
        return this.docs.reopenClosed();
      case 'saveAll': {
        const n = await this.docs.saveAll();
        if (n !== false) toast(n ? `Saved ${n} file${n > 1 ? 's' : ''}` : 'No unsaved changes', { kind: n ? 'success' : 'info' });
        return n !== false;
      }
      case 'newWindow':
        return this.newWindow();
      case 'duplicate':
        return this.fileOps.duplicate();
      case 'renameFile':
        return this.fileOps.rename();
      case 'moveTo':
        return this.fileOps.moveTo();
      case 'revealInFinder':
        return this.fileOps.reveal();
      case 'copyFilePath':
        return this.fileOps.copyPath();
      case 'properties':
        return this.fileOps.properties();
      case 'reopenWithEncoding':
        return this.fileOps.reopenWithEncoding();
      case 'browseVersions':
        return this.fileOps.browseVersions();
      case 'recoverDrafts':
        return this.fileOps.recoverDrafts();
      case 'reloadFromDisk':
        await this.doc.reloadFromDisk();
        return true;
      case 'exportHtml':
      case 'exportPdf':
        return this.export(id === 'exportHtml' ? 'html' : 'pdf');
      case 'exportDocx':
      case 'exportLatex':
      case 'exportEpub':
        return this.exportPandoc(PANDOC_ACTIONS[id]);
      case 'print':
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

  /** File › New Window (#94): another app window, empty or showing `path`. */
  private async newWindow(path?: string): Promise<boolean> {
    const open = extras(this.platform).openWindow;
    if (!open) {
      if (path) return this.docs.openPath(path, 'tab');
      this.docs.newTab();
      return true;
    }
    try {
      // Typora: the new window keeps this window's sidebar folder (native-commands §2.3).
      await open.call(this.platform, { ...(path ? { path } : {}), ...(this.folder ? { folder: this.folder } : {}) });
      return true;
    } catch (e) {
      toast(`Couldn't open a new window: ${e instanceof Error ? e.message : e}`, { kind: 'error' });
      return false;
    }
  }

  private preferences(): void {
    openPreferences({
      settings: () => this.settings,
      update: (p) => this.updateSettings(p),
      themeNames: () => this.themes.names(),
      isDarkTheme: (n) => this.themes.isDark(n),
      openThemesFolder: () => void this.openThemesFolder(),
      pickFolder: () => this.platform.openFileDialog({ directory: true }),
      recoverDrafts: () => void this.fileOps.recoverDrafts(),
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
    });
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
      pick: (it) => void this.docs.openPath(it.id, 'replace'),
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
        if (it.id.startsWith('recent:')) void this.docs.openPath(it.id.slice(7), 'tab');
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

  private async export(kind: 'html' | 'pdf'): Promise<boolean> {
    const md = this.editor.getMarkdown();
    const name = this.doc.path ? stripExt(basename(this.doc.path)) : documentTitle(md, null);
    const base = this.doc.dir ?? this.folder;
    const target = await this.platform.saveFileDialog({
      defaultPath: base ? `${base}/${name}.${kind}` : `${name}.${kind}`,
      filters: [kind === 'html' ? { name: 'HTML', extensions: ['html'] } : { name: 'PDF', extensions: ['pdf'] }],
    });
    if (!target) return false;
    // HTML: local images as paths relative to the exported file (webview asset URLs don't
    // work outside the app). PDF keeps asset URLs, which the native renderer loads (#27).
    if (kind === 'html') this.exportDir = dirname(target);
    let body: string;
    try {
      body = this.editor.renderHTML();
    } finally {
      this.exportDir = null;
    }
    const katex = needsKatex(body) ? await loadKatexCss() : '';
    const html = buildExportHtml({ title: documentTitle(md, this.doc.path ? basename(this.doc.path) : null), body, themeCss: this.themes.exportCss(), extraCss: `${await this.wiring.loadBlocksCss()}\n${katex}` });
    try {
      if (kind === 'html') await this.platform.exportHtml(html, target);
      else await this.platform.exportPdf(html, target, { baseDir: this.doc.dir ?? undefined });
    } catch (e) {
      toast(`Export failed: ${e instanceof Error ? e.message : e}`, { kind: 'error' });
      return false;
    }
    const reveal = extras(this.platform).revealInFolder;
    toast(`Exported ${basename(target)}`, {
      kind: 'success',
      action: reveal ? { label: 'Show', run: () => void reveal.call(this.platform, target) } : undefined,
    });
    return true;
  }

  private exportPandoc(format: PandocFormat): Promise<boolean> {
    const md = this.editor.getMarkdown();
    const reveal = extras(this.platform).revealInFolder;
    return exportWithPandoc(format, {
      platform: this.platform,
      markdown: md,
      name: this.doc.path ? stripExt(basename(this.doc.path)) : documentTitle(md, null),
      docDir: this.doc.dir ?? null,
      fallbackDir: this.folder,
      title: documentTitle(md, this.doc.path ? basename(this.doc.path) : null),
      pandocPath: this.settings.pandocPath,
      progress: (m) => toast(m, { kind: 'info', timeout: 0 }),
      notify: (m, kind, action) => void toast(m, { kind, action }),
      reveal: reveal ? (p) => void reveal.call(this.platform, p).catch(() => {}) : undefined,
    });
  }

  /** For tests / devtools. */
  get commandSpec(): typeof commandSpec {
    return commandSpec;
  }
}
