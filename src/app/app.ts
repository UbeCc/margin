import { saveMediaAs } from './images/context-menu';
import { ExternalChangeBanner } from './ui/extchange';
import type { EditorHandle, EditorSettings, ImageMenuAction, MenuAction, Platform } from '../contracts';
import type { Wiring } from './wiring';
import { COMMANDS, commandForKey, commandSpec, isCommandId, setCustomKeys, type CommandId } from './commands';
import { DocumentController, type DocState } from './document';
import { DocTabs, type DocTab, type DocHostCallbacks } from './doctabs';
import { TabBar } from './tabs';
import { FileOps } from './fileops';
import { VersionStore } from './versions';
import { DraftStore, type Draft } from './drafts';
import { documentTitle, loadKatexCss, needsKatex } from './export';
import { ExportController, registerPandocExporters } from './export-actions';
import { DEFAULT_PRINT_SETUP, effectivePage, pageCss, type PrintSetup } from './export-settings';
import { confirmOverwriteDialog, openExportingSheet, openPageSetup } from './export-ui';
import { runImport, type ImportHost } from './import';
import { copyMathAsImage } from './math-image';
import { FindBar } from './findbar';
import type { FindOpts } from './findmatches';
import { extras } from './platform-extras';
import { openPreferences, type Section } from './preferences';
import { DEFAULT_SETTINGS, launchPlan, newFileEol, migrateSettings, pushRecent, type MarginSettings } from './settings';
import type { FileTree } from './sidebar/filetree';
import { FilesPanel } from './sidebar/files-panel';
import { installSidebarDrop } from './sidebar/drop-editor';
import { OutlineView } from './sidebar/outline';
import { StatusBar } from './statusbar';
import { countMarkdown, countWords } from './wordcount';
import { EmojiComplete, installSmartPunctuation, startSpeaking, stopSpeaking } from './writing-aids';
import { ThemeManager } from './themes';
import { themeLabel } from '../themes';
import { ask } from './ui/modal';
import { insertTableDialog } from './ui/table-dialog';
import { closePalette, isPaletteOpen, openPalette, type PaletteItem } from './ui/palette';
import { toast } from './ui/toast';
import { handleFileDrop } from './filedrop';
import { PANDOC_ACTIONS, type PandocFormat } from './export-pandoc';
import { closeContextMenu } from './ui/contextmenu';
import { EditorContextMenu } from './ctxmenu';
import { ImageUploader } from './upload-actions';
import { ImageFeature } from './images/feature';
import { takePicture } from './images/take-picture';
import { debounce, h } from './util/dom';
import { fuzzyFilter, fuzzyMatch } from './util/fuzzy';
import { formatShortcut, isMac } from './util/keymap';
import { matchShortcut as nativeShortcut } from '../platform/shortcuts';
import { basename, dirname, displayPath, fileUrl, isAbsolute, isInside, isMarkdownPath, isUrlLike, relative, relativeFrom, resolveDocPath, stripExt } from './util/path';

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
  /** Host element of the active tab's editor (writing aids / speech scope). */
  get editorHost(): HTMLElement {
    return this.docs.active.host;
  }
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
  private page!: HTMLElement;
  private uploader!: ImageUploader;
  private images!: ImageFeature;
  private syncImagesSoon = debounce(() => this.images.sync(), 300);
  private scroller!: HTMLElement;
  private tabBar!: TabBar;
  private tree!: FileTree;
  private files!: FilesPanel;
  private outline!: OutlineView;
  private findbar!: FindBar;
  private status!: StatusBar;
  private tabs: Record<'files' | 'outline', HTMLButtonElement> = {} as never;
  private outlineDropdown: HTMLElement | null = null;

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
  private refreshStatsSoon = debounce(() => this.refreshStats(), 200);
  private refreshSelectionSoon = debounce(() => this.refreshSelectionStats(), 50);
  /** View › Always on Top: per window, never persisted (native-commands §5.1). */
  private alwaysOnTop = false;
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
    // #100 Appearance › Show Outline Panel by Default
    if (this.settings.showOutlineByDefault) this.settings = { ...this.settings, sidebarTab: 'outline', sidebarVisible: true };
    setCustomKeys(this.settings.keyBinding);
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
    this.exports = this.createExports();
    // #80: "Upload Image" context menu + "Upload All Local Images" command.
    this.uploader = new ImageUploader({
      platform: this.platform,
      editor: () => this.editor,
      baseDir: () => this.doc.dir,
      settings: () => this.settings,
      notify: (m, k, action) => void toast(m, { kind: k, ...(action ? { action } : {}) }),
    });
    this.editor.onChange(() => {
      this.refreshFindSoon();
      this.refreshOutlineSoon();
      this.refreshStatsSoon();
    });
    let selRaf = 0;
    this.editor.onSelectionChange(() => {
      cancelAnimationFrame(selRaf);
      selRaf = requestAnimationFrame(() => this.outline.setActive(this.editor.getActiveHeadingId()));
      this.refreshSelectionSoon();
    });
    // #99: image rules, Format › Image, image context menu, typora-root-url.
    this.images = new ImageFeature({
      platform: extras(this.platform) as Platform & ReturnType<typeof extras>,
      editor: () => this.editor,
      editorRoot: () => this.docs.active.host,
      docPath: () => this.doc.path,
      settings: () => this.settings,
      uploader: this.uploader,
      notify: (m, k, action) => void toast(m, { kind: k, ...(action ? { action } : {}) }),
      saveAs: () => void this.doc.saveAs(),
      openImagePreferences: () => this.preferences('images'),
      resolveAsset: (src) => this.resolveAsset(src),
      assetsChanged: () => this.assetsChanged(),
    });
    this.images.attach(this.page); // tab hosts live in the page (#94)
    this.docs.newTab();
    // #97: editor context menus (text, link, image, table, code, math, diagram, atomic blocks).
    new EditorContextMenu(
      {
        editor: () => this.editor,
        platform: this.platform,
        run: (id) => this.run(id),
        openLink: (href) => void this.openLink(href),
        baseDir: () => this.doc.dir,
        uploadImage: (src) => void this.uploader.uploadSrcs([src]),
        imageOps: (t) => (t.img ? this.images.ctxOps(t.img) : null),
        saveVideoAs: (src) => void saveMediaAs({ platform: this.platform, notify: (m, k) => void toast(m, { kind: k }) }, null, src, 'Video'),
        notify: (m, k) => void toast(m, { kind: k }),
      },
      this.page, // active tab's editor host lives here (#94)
    ).attach();

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
        await this.persistSettings();
      }
      return ok;
    });
    window.addEventListener('blur', () => void this.doc.flushAutoSave());
    // Don't lose a just-changed preference to the save debounce on reload / quit (#100).
    window.addEventListener('pagehide', () => this.saveSettingsSoon.flush());

    // Initial content — General › On Launch (#100)
    const { folder, file } = launchPlan(this.settings, opts.fresh ? { ...opts, initialFolder: null } : opts);
    if (folder && !opts.fresh) await this.openFolder(folder, { quiet: true });
    if (file && !opts.fresh && (await this.platform.stat(file))) await this.docs.openPath(file, 'replace');
    else this.onDocState(this.doc.state());
    this.refreshOutline();
    this.refreshStats();
    this.status.setSource(this.editor.isSourceMode());
    this.root.classList.add('ready');
    if (!opts.fresh) void this.offerDrafts();
  }

  /** One editor per tab; chrome refreshes only follow the active one. */
  private createTabEditor(host: HTMLElement, tab: DocTab): EditorHandle {
    const ed = this.wiring.createEditor(host, this.editorSettings(tab));
    ed.onChange(() => {
      if (tab.doc?.dirty) this.saveDraftsSoon();
      if (this.docs.active !== tab) return;
      this.syncImagesSoon();
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
      willLoad: (p) => tab.editor.updateSettings({ baseDir: p ? dirname(p) : null, docUrl: fileUrl(p) }),
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
      defaultEol: () => newFileEol(this.settings.defaultLineEnding),
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
    if (r.id !== 'create' && this.settings.recentFiles.includes(path)) {
      this.updateSettings({ recentFiles: this.settings.recentFiles.filter((x) => x !== path) });
    }
    return r.id === 'create';
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
    this.images?.sync(); // typora-root-url follows the active document (#99)
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
      assetKey: this.assetKey,
      resolveAsset: (src) => this.resolveAsset(src, tab),
      storeImage: (input) => this.storeImage(input),
      openLink: (href) => void this.openLink(href),
      ...(this.platform.writeClipboardNative ? { writeClipboardNative: (d) => this.platform.writeClipboardNative!(d) } : {}),
      docUrl: fileUrl(tab?.doc?.path),
      ...(this.platform.writeClipboardRich ? { writeClipboardRich: (d) => this.platform.writeClipboardRich!(d) } : {}),
      // #127 Copy Math ▸ Copy as Image: rasterize KaTeX → PNG on the clipboard.
      copyMathImage: async (tex, display) => {
        const ok = await copyMathAsImage(tex, display);
        if (!ok) toast('Could not copy the math image.', { timeout: 3000 });
        return ok;
      },
      ...(this.platform.readClipboard ? { readClipboard: () => this.platform.readClipboard!() } : {}),
      spellcheck: this.settings.spellcheck,
      autocorrect: this.settings.spellAutocorrect || this.settings.smartTextReplacement,
      typewriterCaret: this.settings.typewriterCaret,
      copyMarkdownByDefault: this.settings.copyMarkdownByDefault,
      lineWiseCopyCut: this.settings.lineWiseCopyCut,
      focusMode: this.settings.focusMode,
      typewriterMode: this.settings.typewriterMode,
      colorScheme: this.colorScheme,
      markdown: { ...this.settings.markdown },
    };
  }

  // ======================================================== layout

  private buildLayout(): void {
    this.titleEl = h('span.title-text', { text: 'Untitled' });
    const titlebar = h('header.titlebar', { 'data-tauri-drag-region': '' }, h('div.title', { 'data-tauri-drag-region': '' }, this.titleEl));

    this.files = new FilesPanel({
      settings: () => this.settings,
      updateSettings: (p) => this.updateSettings(p),
      openAt: (p, q, o, n) => void this.openAt(p, q, o, n),
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
      moveConfirm: () => this.settings.confirmSidebarMove,
      onMoveConfirmSuppressed: () => this.updateSettings({ confirmSidebarMove: false }),
    });
    this.tree = this.files.tree;
    this.outline = new OutlineView(
      (id) => {
        this.caretToBlock(id);
        this.editor.scrollToHeading(id);
        this.outline.setActive(id);
      },
      {
        collapsible: this.settings.outlineCollapsible,
        onCollapsibleChange: (on) => this.updateSettings({ outlineCollapsible: on }),
        pinned: this.settings.outlinePinned,
        onPinnedChange: (on) => this.setOutlinePinned(on),
      },
    );

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
      h('div.sidebar-panel', { 'data-panel': 'files' }, this.files.el),
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
    installSidebarDrop(this.scroller, {
      docDir: () => (this.doc.path ? dirname(this.doc.path) : null),
      editor: () => this.editor,
    });
    const main = h('main.main', null, this.tabBar.el, this.findbar.el, this.extBanner.el, this.scroller);

    this.status = new StatusBar({
      toggleSidebar: () => void this.run('toggleSidebar'),
      toggleSource: () => void this.run('toggleSource'),
      toggleEol: () => void this.run('toggleLineEnding'),
      setUnit: (u) => this.updateSettings({ wordCountUnit: u }),
    });
    const aids = {
      root: this.editorHost,
      editor: () => this.editor,
      smart: () => ({ quotes: this.settings.markdown.smartQuote, dashes: this.settings.markdown.smartDash, onInput: this.settings.markdown.smartPunctuation === 'input' }),
    };
    installSmartPunctuation(aids);
    document.body.appendChild(new EmojiComplete(aids).el);

    this.root.replaceChildren(titlebar, h('div.workspace', null, this.sidebar, main), this.status.el, this.status.floating);
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
    this.root.classList.toggle('statusbar-hidden', !s.statusBarVisible);
    if (this.status) {
      this.status.floating.hidden = s.statusBarVisible || !s.alwaysShowWordCount;
      this.status.setUnit(s.wordCountUnit);
      this.status.setReadingSpeed(s.wordsPerMinute);
    }
    this.syncMenuChecks();
    document.documentElement.style.setProperty('zoom', s.zoom === 1 ? '' : String(s.zoom));
    // #100 Appearance › Text Column Width (0 = theme default)
    this.root.style.setProperty('--margin-column-width', s.textColumnWidth ? `${s.textColumnWidth}px` : '');
    this.root.dataset.windowStyle = s.windowStyle;
  }

  private applyAppearance(): void {
    const { dark } = this.themes.apply(this.settings);
    const scheme = dark ? 'dark' : 'light';
    if (scheme !== this.colorScheme) {
      this.colorScheme = scheme;
      for (const ed of this.docs?.editors() ?? []) ed.updateSettings({ colorScheme: scheme });
    }
  }

  /** Status bar counts from the raw Markdown (fe-sidebar-statusbar-find §8). */
  private refreshStats(): void {
    this.status.setStats(countMarkdown(this.editor.getMarkdown()));
  }

  private refreshSelectionStats(): void {
    const sel = window.getSelection();
    const inside = !!sel && !sel.isCollapsed && !!sel.anchorNode && this.editorHost.contains(sel.anchorNode);
    const text = inside ? sel!.toString() : '';
    const all = inside && text.length >= (this.editorHost.innerText ?? '').trim().length;
    this.status.setSelection(text && !all ? { words: countWords(text), characters: text.length } : null);
  }

  private lastChecks = '';
  /** Native check marks follow app state (#103 menu.state-sync). */
  private syncMenuChecks(): void {
    const set = extras(this.platform).setMenuChecked;
    if (!set) return;
    const s = this.settings;
    // §5.4: in Convert-on-Input mode with quotes or dashes on, Remap Unicode
    // Punctuation on Parse is forced on and greyed out.
    const remapForced = s.markdown.smartPunctuation === 'input' && (s.markdown.smartQuote || s.markdown.smartDash);
    const checks: [string, boolean][] = [
      ['toggleStatusBar', s.statusBarVisible],
      ['alwaysOnTop', this.alwaysOnTop],
      ['toggleMagnification', s.allowMagnification],
      ['spell:toggle', s.spellcheck],
      ['spell:grammar', s.spellGrammar],
      ['spell:autocorrect', s.spellAutocorrect],
      ['subst:input', s.markdown.smartPunctuation === 'input'],
      ['subst:render', s.markdown.smartPunctuation === 'rendering'],
      ['subst:quotes', s.markdown.smartQuote],
      ['subst:dashes', s.markdown.smartDash],
      ['subst:textReplacement', s.smartTextReplacement],
      ['subst:remap', remapForced || s.markdown.remapPunctuation],
      ['toggleFocus', s.focusMode],
      ['toggleTypewriter', s.typewriterMode],
    ];
    const key = JSON.stringify(checks);
    if (key === this.lastChecks) return;
    this.lastChecks = key;
    const enable = extras(this.platform).setMenuEnabled;
    void enable?.call(this.platform, 'subst:remap', !remapForced).catch(() => {});
    for (const [id, on] of checks) void set.call(this.platform, id, on).catch(() => {});
  }

  private showSidebarTab(id: 'files' | 'outline'): void {
    this.closeOutlineDropdown();
    this.updateSettings({ sidebarTab: id, sidebarVisible: true });
    if (id === 'outline') this.refreshOutline();
  }

  /**
   * Outline pin/unpin (#131, fe-sidebar §10): unpinning hides the sidebar and
   * shows the outline as a floating drop-down; pinning restores the sidebar
   * "Outline" tab. The drop-down closes on Escape / outside click and reopens
   * from View ▸ Outline (or the status-bar toggle) while unpinned.
   */
  private setOutlinePinned(on: boolean): void {
    if (on) {
      this.closeOutlineDropdown();
      this.updateSettings({ outlinePinned: true, sidebarTab: 'outline', sidebarVisible: true });
      this.refreshOutline();
    } else {
      this.updateSettings({ outlinePinned: false, sidebarVisible: false });
      this.openOutlineDropdown();
    }
  }

  private openOutlineDropdown(): void {
    if (!this.outlineDropdown) {
      this.outlineDropdown = h('div.outline-dropdown', { 'aria-label': 'Outline' });
      const onDocClick = (e: MouseEvent): void => {
        if (this.outlineDropdown?.contains(e.target as Node)) return;
        this.closeOutlineDropdown();
      };
      const onKey = (e: KeyboardEvent): void => {
        if (e.key !== 'Escape') return;
        e.stopPropagation();
        this.closeOutlineDropdown();
      };
      document.addEventListener('mousedown', onDocClick, true);
      document.addEventListener('keydown', onKey, true);
    }
    this.outlineDropdown.replaceChildren(this.outline.el);
    this.root.appendChild(this.outlineDropdown);
    this.refreshOutline();
  }

  private closeOutlineDropdown(): void {
    const dd = this.outlineDropdown;
    if (!dd) return;
    this.outlineDropdown = null;
    // Put the outline back into its sidebar panel (hidden while the sidebar is).
    this.root.querySelector('.sidebar-panel[data-panel="outline"]')?.appendChild(this.outline.el);
    dd.remove();
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
    if (JSON.stringify(s.markdown) !== JSON.stringify(prev.markdown)) ed.markdown = { ...s.markdown };
    if (JSON.stringify(s.keyBinding) !== JSON.stringify(prev.keyBinding)) {
      const bad = setCustomKeys(s.keyBinding);
      if (bad.length) void toast(`Unknown command in custom shortcut keys: ${bad.join(', ')}`, { kind: 'warning' });
    }
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
    this.files.setActive(s.path);
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

  /** Sidebar search result: open the file, then find the query in it. */
  private async openAt(path: string, query: string | null, opts: FindOpts, occurrence: number): Promise<void> {
    if (path !== this.doc.path && !(await this.docs.openPath(path, 'replace'))) return;
    if (query) this.findbar.searchFor(query, opts, occurrence);
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
    await this.files.setRoot(path);
    if (this.doc.path) await this.tree.reveal(this.doc.path);
    try {
      const un = await this.platform.watch(path, (evs) => this.files.onFsEvents(evs));
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
    }).then((r) => r.id);
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
    return r.id === 'reload';
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
  /** File › Page Setup (session only, like Typora's shared print info). */
  private printSetup: PrintSetup = { ...DEFAULT_PRINT_SETUP };

  /** Bumped whenever image asset resolution changes (#136: typora-root-url). */
  private assetKey = '0';

  private assetsChanged(): void {
    this.assetKey = String(Number(this.assetKey) + 1);
    for (const e of this.docs.editors()) e.updateSettings({ assetKey: this.assetKey });
  }

  private resolveAsset(src: string, tab?: DocTab): string {
    const doc = tab?.doc ?? this.docs?.active?.doc;
    // typora-root-url (#99) is tracked for the active tab's document.
    const rooted = !tab || tab === this.docs?.active ? this.images?.resolvePath(src) : undefined;
    const p = rooted !== undefined ? rooted : resolveDocPath(src, doc?.dir ?? null);
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
    if (id === 'mark:math' || id === 'mark:highlight') this.enableSyntaxFor(id === 'mark:math' ? 'inlineMath' : 'highlight');
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
      case 'toggleStatusBar':
        this.updateSettings({ statusBarVisible: !this.settings.statusBarVisible });
        return true;
      case 'wordCount':
        this.status.openPopover(this.settings.statusBarVisible || this.status.floating.hidden ? undefined : this.status.floating);
        return true;
      case 'alwaysOnTop': {
        const set = extras(this.platform).setAlwaysOnTop;
        if (!set) {
          toast('Always on Top is available in the desktop app', { kind: 'info' });
          return true;
        }
        this.alwaysOnTop = await set.call(this.platform, !this.alwaysOnTop).catch(() => this.alwaysOnTop);
        this.lastChecks = '';
        this.syncMenuChecks();
        return true;
      }
      case 'toggleMagnification':
        this.updateSettings({ allowMagnification: !this.settings.allowMagnification });
        void extras(this.platform).setMagnification?.call(this.platform, this.settings.allowMagnification).catch(() => {});
        return true;
      case 'toggleDevtools':
        await extras(this.platform).toggleDevtools?.call(this.platform).catch(() => {});
        return true;
      case 'spell:toggle':
        this.updateSettings({ spellcheck: !this.settings.spellcheck });
        return true;
      case 'spell:panel':
        await extras(this.platform).showSpellingPanel?.call(this.platform).catch(() => {});
        return true;
      case 'spell:now': {
        // Typora runs the system checker over the editable area (§5.3); on the
        // web the closest equivalent is re-running the browser spellcheck pass.
        const ed = this.editorHost.querySelector('.md-editor') as HTMLElement | null;
        if (ed?.spellcheck) {
          ed.spellcheck = false;
          void ed.offsetHeight;
          ed.spellcheck = true;
        }
        return true;
      }
      case 'spell:grammar':
        this.updateSettings({ spellGrammar: !this.settings.spellGrammar });
        return true;
      case 'spell:autocorrect':
        this.updateSettings({ spellAutocorrect: !this.settings.spellAutocorrect });
        return true;
      case 'subst:input':
      case 'subst:render':
        this.updateSettings({ markdown: { ...this.settings.markdown, smartPunctuation: id === 'subst:input' ? 'input' : 'rendering' } });
        return true;
      case 'subst:quotes':
        this.updateSettings({ markdown: { ...this.settings.markdown, smartQuote: !this.settings.markdown.smartQuote } });
        return true;
      case 'subst:dashes':
        this.updateSettings({ markdown: { ...this.settings.markdown, smartDash: !this.settings.markdown.smartDash } });
        return true;
      case 'subst:textReplacement':
        this.updateSettings({ smartTextReplacement: !this.settings.smartTextReplacement });
        return true;
      case 'subst:remap':
        this.updateSettings({ markdown: { ...this.settings.markdown, remapPunctuation: !this.settings.markdown.remapPunctuation } });
        return true;
      case 'subst:more':
        this.preferences('markdown');
        return true;
      case 'emojiPicker': {
        // "Emoji and Symbols": the system picker on desktop; here, open the
        // :shortcode: autocomplete at the caret (fe-preferences §10).
        this.editorHost.dispatchEvent(new CustomEvent('margin:emoji'));
        return true;
      }
      case 'speech:start':
        if (!startSpeaking(this.editorHost)) toast('Speech is not available here', { kind: 'warning' });
        return true;
      case 'speech:stop':
        stopSpeaking();
        return true;
      case 'toggleSidebar':
        this.updateSettings({ sidebarVisible: !this.settings.sidebarVisible });
        return true;
      case 'showFiles':
      case 'showOutline': {
        const tab = id === 'showFiles' ? 'files' : 'outline';
        if (tab === 'outline' && !this.settings.outlinePinned) {
          // Unpinned: the drop-down outline replaces the sidebar tab (#131).
          if (this.outlineDropdown) this.closeOutlineDropdown();
          else this.openOutlineDropdown();
          return true;
        }
        if (this.settings.sidebarVisible && this.settings.sidebarTab === tab) this.updateSettings({ sidebarVisible: false });
        else this.showSidebarTab(tab);
        return true;
      }
      case 'showArticles':
        if (this.settings.sidebarVisible && this.settings.sidebarTab === 'files' && this.files.mode === 'list') this.updateSettings({ sidebarVisible: false });
        else {
          this.showSidebarTab('files');
          await this.files.setMode('list');
        }
        return true;
      case 'sidebarSearch': {
        this.showSidebarTab('files');
        const sel = window.getSelection()?.toString().trim();
        await this.files.openSearch(sel && sel.length < 200 ? sel : undefined);
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
      case 'toggleFinalNewline':
        this.doc.setFinalNewline(!this.doc.finalNewline);
        toast(`Insert Final New Line On Save: ${this.doc.finalNewline ? 'on' : 'off'}`, { timeout: 1500 });
        return true;
      case 'toggleLineEnding':
        this.doc.setEol(this.doc.eol === '\n' ? '\r\n' : '\n');
        return true;
      case 'preferences':
        this.preferences();
        return true;
      case 'openThemesFolder':
        await this.openThemesFolder();
        return true;
      case 'takePicture':
        return takePicture({
          editor: () => this.editor,
          store: (input) => this.images.store(input),
          notify: (m, k) => void toast(m, { kind: k }),
        });
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
      await open.call(this.platform, path ? { path } : {});
      return true;
    } catch (e) {
      toast(`Couldn't open a new window: ${e instanceof Error ? e.message : e}`, { kind: 'error' });
      return false;
    }
  }

  /**
   * Format › Inline Math / Highlight while that syntax is off (Typora's fresh-install default):
   * turn it on so the inserted `$…$` / `==…==` renders, and say where the switch lives (#102).
   */
  private enableSyntaxFor(key: 'inlineMath' | 'highlight'): void {
    if (this.settings.markdown[key]) return;
    this.updateSettings({ markdown: { ...this.settings.markdown, [key]: true } });
    toast(`${key === 'inlineMath' ? 'Inline Math' : 'Highlight'} syntax enabled (Preferences › Markdown › Syntax Support)`, { timeout: 3000 });
  }

  private preferences(section?: Section): void {
    openPreferences({
      settings: () => this.settings,
      update: (p) => this.updateSettings(p),
      themeNames: () => this.themes.names(),
      isDarkTheme: (n) => this.themes.isDark(n),
      openThemesFolder: () => void this.openThemesFolder(),
      pickFolder: () => this.platform.openFileDialog({ directory: true }),
      recoverDrafts: () => void this.fileOps.recoverDrafts(),
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
      pick: (it) => void this.docs.openPath(it.id, 'replace'),
    });
  }

  commandPalette(): void {
    // #127 menu enable state: Code Tools items run only inside a code fence / math / HTML block
    // (Typora Paragraph › Code Tools, fe-contextmenus-tools §7).
    const block = this.editor.caretBlockType();
    const codeToolsOk = block === 'code_fence' || block === 'diagram' || block === 'math_block' || block === 'html_block';
    const items: { id: string; text: string; label: string; detail: string; hint?: string; disabled?: boolean }[] = [];
    for (const c of COMMANDS) {
      items.push({ id: c.id, text: `${c.category}: ${c.label}`, label: `${c.category}: ${c.label}`, detail: '', hint: c.keys?.[0] ? formatShortcut(c.keys[0]) : undefined, disabled: c.id.startsWith('code:') ? !codeToolsOk : undefined });
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
          disabled: item.disabled,
        })),
      pick: (it) => {
        if (it.id.startsWith('custom:')) void this.exports.export(it.id);
        else if (it.id.startsWith('recent:')) void this.docs.openPath(it.id.slice(7), 'tab');
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
      openPandocSettings: () => this.preferences('export'),
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

