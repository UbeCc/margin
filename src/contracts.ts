/**
 * Cross-module contracts for Margin. Each module owner implements its side;
 * change a signature here only with a note in ARCHITECTURE.md.
 *
 *   editor/core    → EditorHandle, uses BlockWidget registry
 *   editor/blocks  → BlockWidget implementations, source mode
 *   app            → shell UI, uses EditorHandle + Platform
 *   platform       → Platform (Tauri impl + in-browser mock)
 */

// ---------------------------------------------------------------- editor API

export interface Heading {
  /** Stable block id of the heading block. */
  id: string;
  level: 1 | 2 | 3 | 4 | 5 | 6;
  /** Plain text (markers stripped). */
  text: string;
}

export interface EditorSettings {
  /** Base directory used to resolve relative image / link paths. null = unsaved doc. */
  baseDir: string | null;
  /** Resolve a document-relative src to something the webview can load. */
  resolveAsset(src: string): string;
  /** Called when the user pastes / drops image data or files. Returns the markdown src to insert. */
  storeImage?(input: { bytes?: Uint8Array; mime?: string; path?: string; name?: string }): Promise<string | null>;
  /** Open an external link. */
  openLink?(href: string): void;
  /** Optional (#79): add native rich flavours (RTF) after a copy; see `RichClipboardData`. */
  writeClipboardRich?(data: RichClipboardData): Promise<boolean>;
  spellcheck: boolean;
  /** Visual modes. */
  focusMode: boolean;
  typewriterMode: boolean;
  /** "light" | "dark" — widgets (code highlight, mermaid) follow it. */
  colorScheme: 'light' | 'dark';
}

/** Inline formats toggled by Format menu commands (`underline`/`sub`/`sup` = `<u>`/`<sub>`/`<sup>`, `math` = `$…$`, `comment` = `<!-- … -->`). */
export type InlineMark = 'strong' | 'em' | 'code' | 'strike' | 'highlight' | 'link' | 'underline' | 'sub' | 'sup' | 'math' | 'comment';
/** Blocks inserted / toggled by Paragraph menu commands (`linkRef` = `[id]: url` definition, `footnote` = `[^n]` + definition). */
export type BlockKind =
  | 'quote' | 'ul' | 'ol' | 'task' | 'code' | 'math' | 'table' | 'hr' | 'toc' | 'front_matter' | 'html' | 'linkRef' | 'footnote';

export type EditorCommand =
  | { kind: 'heading'; level: 0 | 1 | 2 | 3 | 4 | 5 | 6 } // 0 = paragraph
  /** +1 = Increase Heading Level (H2 → H1, paragraph → H6), -1 = Decrease (H1 → H2, H6 → paragraph). */
  | { kind: 'headingLevel'; delta: 1 | -1 }
  | { kind: 'mark'; mark: InlineMark }
  | { kind: 'block'; block: BlockKind }
  /** Insert an empty paragraph before / after the block containing the caret. */
  | { kind: 'insertParagraph'; where: 'before' | 'after' }
  /** Task items in the selection: toggle / check / uncheck. */
  | { kind: 'task'; op: 'toggle' | 'complete' | 'incomplete' }
  /** Remove inline formatting markers in the selection (whole block when collapsed). */
  | { kind: 'clearFormat' }
  | { kind: 'insertText'; text: string }
  | { kind: 'insertImage'; src: string; alt?: string }
  | { kind: 'undo' }
  | { kind: 'redo' }
  | { kind: 'selectAll' }
  | { kind: 'find'; query: string; caseSensitive?: boolean; backwards?: boolean }
  | { kind: 'replace'; query: string; replacement: string; all?: boolean };

export interface EditorStats {
  words: number;
  characters: number;
  lines: number;
}

export interface EditorHandle {
  /** Replace the whole document. Resets undo history and dirty state. */
  setMarkdown(markdown: string): void;
  /** Lossless: getMarkdown() right after setMarkdown(x) MUST return x byte-for-byte. */
  getMarkdown(): string;
  /** Fires (debounced by caller if needed) after every document change. */
  onChange(cb: () => void): () => void;
  onSelectionChange(cb: () => void): () => void;
  getOutline(): Heading[];
  /** Id of the heading containing the caret, if any. */
  getActiveHeadingId(): string | null;
  scrollToHeading(id: string): void;
  exec(cmd: EditorCommand): boolean;
  getStats(): EditorStats;
  setSourceMode(on: boolean): void;
  isSourceMode(): boolean;
  updateSettings(patch: Partial<EditorSettings>): void;
  /** Rendered HTML for export (no editing chrome, md-meta removed). */
  renderHTML(): string;
  focus(): void;
  destroy(): void;
}

export type CreateEditor = (host: HTMLElement, settings: EditorSettings) => EditorHandle;

// ---------------------------------------------------------- block widgets

/** Special (non-text) blocks are rendered by widgets. Raw = exact markdown source of the block. */
export type WidgetBlockType =
  | 'code_fence'
  | 'math_block'
  | 'diagram' // fenced ```mermaid
  | 'table'
  | 'html_block'
  | 'front_matter'
  | 'toc';

export interface WidgetContext {
  raw: string;
  settings: EditorSettings;
  /** Widget edited its content: give the new exact markdown source of the block. */
  onChange(raw: string): void;
  /** Caret wants to leave the widget (arrow keys at the edge, Escape, etc.). */
  onExit(direction: 'up' | 'down' | 'left' | 'right'): void;
  /** Ask the editor to delete this block (e.g. Backspace in empty widget). */
  onRemove(): void;
  getOutline(): Heading[];
  scrollToHeading(id: string): void;
}

export interface WidgetInstance {
  /** Source changed from outside (undo, source mode round-trip). */
  update(raw: string): void;
  focus(at: 'start' | 'end'): void;
  /** For export: static HTML rendering of this block. */
  renderHTML(): string;
  /** Settings changed (theme etc.). */
  updateSettings?(settings: EditorSettings): void;
  /**
   * Find support: select the given character range of this widget's own content
   * (offsets into `raw`, end exclusive) and scroll it into view. Return false when
   * the range is not editable/selectable inside the widget (the core then selects
   * the whole widget as before).
   */
  select?(from: number, to: number): boolean;
  destroy(): void;
}

export interface BlockWidget {
  type: WidgetBlockType;
  mount(host: HTMLElement, ctx: WidgetContext): WidgetInstance;
}

/** Inline math `$...$` rendering, used by the core inline renderer. */
export type RenderInlineMath = (tex: string, el: HTMLElement) => void;

// ---------------------------------------------------------------- platform

export interface DirEntry {
  name: string;
  path: string;
  isDir: boolean;
  /** ms since epoch */
  mtime: number;
  size: number;
}

export type FsEvent =
  | { kind: 'created' | 'removed' | 'modified'; path: string }
  | { kind: 'renamed'; from: string; to: string };

export type ImageRule =
  | { kind: 'relative'; dir: string } // e.g. "./assets" or "./${filename}.assets"
  | { kind: 'absolute'; dir: string }
  | { kind: 'none' }; // keep original path

export interface AppSettings {
  theme: string; // theme file name without .css
  colorScheme: 'light' | 'dark' | 'system';
  fontSize: number;
  autoSave: boolean;
  imageRule: ImageRule;
  spellcheck: boolean;
  recentFiles: string[];
  recentFolders: string[];
  lastFolder: string | null;
}

export type MenuAction =
  | 'new' | 'open' | 'openFolder' | 'save' | 'saveAs' | 'close'
  | 'exportHtml' | 'exportPdf' | 'print'
  | 'exportDocx' | 'exportLatex' | 'exportEpub'
  | 'undo' | 'redo' | 'find' | 'replace'
  | 'toggleSidebar' | 'toggleSource' | 'toggleFocus' | 'toggleTypewriter' | 'quickOpen'
  | 'zoomIn' | 'zoomOut' | 'zoomReset'
  | 'clearRecent' | 'commandPalette' | 'showOutline' | 'showFiles' | 'revealActiveFile' | 'reloadFromDisk' | 'toggleLineEnding'
  | `heading:${0 | 1 | 2 | 3 | 4 | 5 | 6}`
  | `mark:${InlineMark}`
  | `block:${BlockKind}`
  | 'para:headingUp' | 'para:headingDown' | 'para:insertBefore' | 'para:insertAfter'
  | 'task:toggle' | 'task:complete' | 'task:incomplete' | 'clearFormat'
  | `theme:${string}`
  | 'preferences';

export interface Platform {
  readonly kind: 'tauri' | 'web';
  readTextFile(path: string): Promise<string>;
  /** Atomic write (temp file + rename). */
  writeTextFile(path: string, content: string): Promise<void>;
  stat(path: string): Promise<DirEntry | null>;
  listDir(path: string): Promise<DirEntry[]>;
  /** Recursive watch; returns an unsubscribe function. */
  watch(path: string, cb: (events: FsEvent[]) => void): Promise<() => void>;
  /** Fuzzy file search under root (markdown files first). */
  quickOpen(root: string, query: string, limit?: number): Promise<string[]>;
  /** Copy / write an image next to the document according to rule; returns markdown src. */
  storeImage(
    docPath: string | null,
    rule: ImageRule,
    input: { bytes?: Uint8Array; mime?: string; path?: string; name?: string },
  ): Promise<string>;
  openFileDialog(opts?: { directory?: boolean }): Promise<string | null>;
  saveFileDialog(opts?: { defaultPath?: string; filters?: { name: string; extensions: string[] }[] }): Promise<string | null>;
  /** Write HTML, or print given HTML to PDF at outPath. */
  exportHtml(html: string, outPath: string): Promise<void>;
  /** baseDir: directory relative srcs resolve against (default: outPath's directory). */
  exportPdf(html: string, outPath: string, opts?: { baseDir?: string }): Promise<void>;
  /** Print the current window (system print dialog). */
  print(): Promise<void>;
  /** Allow the webview to load assets from dir (non-recursive), e.g. images outside the opened folder. */
  allowAssetDir(dir: string): Promise<void>;
  loadSettings(): Promise<AppSettings>;
  saveSettings(s: AppSettings): Promise<void>;
  /** CSS texts of available themes, keyed by name (built-ins + user themes dir). */
  listThemes(): Promise<Record<string, string>>;
  themesDir(): Promise<string>;
  /** URL the webview can load for a local absolute path. */
  assetUrl(path: string): string;
  openExternal(url: string): Promise<void>;
  setTitle(title: string): Promise<void>;
  setDocumentEdited(edited: boolean): Promise<void>;
  onMenu(cb: (action: MenuAction) => void): () => void;
  /** Files opened via Finder / CLI args / drag onto dock. */
  onOpenFiles(cb: (paths: string[]) => void): () => void;
  /** Return false from cb to cancel closing (e.g. unsaved changes). */
  onCloseRequested(cb: () => Promise<boolean>): () => void;
  /**
   * Optional (#80): upload local images (absolute paths) and return one URL per path, in order.
   * `command` is tokenized into argv and run without a shell; PicGo is contacted on 127.0.0.1 only.
   */
  uploadImages?(paths: string[], config: UploadConfig): Promise<string[]>;
  /** Optional (#79, macOS): add public.rtf to the pasteboard after WebKit wrote `marker`'s copy. */
  writeClipboardRich?(data: RichClipboardData): Promise<boolean>;
}

/**
 * Rich copy payload (#79). `marker` is a nonce embedded in `html`; native code
 * appends RTF only once the pasteboard's HTML contains it (else writes all
 * flavours itself). Resolves false when nothing was written.
 */
export interface RichClipboardData {
  plain: string;
  html: string;
  rtf: string;
  markdown: string;
  marker: string;
}

/** #80 image uploader config passed to `Platform.uploadImages`. timeoutSecs is per image. */
export type UploadConfig =
  | { kind: 'command'; command: string; timeoutSecs?: number }
  | { kind: 'picgo'; port?: number; timeoutSecs?: number };
