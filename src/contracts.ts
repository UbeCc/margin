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
  spellcheck: boolean;
  /** Visual modes. */
  focusMode: boolean;
  typewriterMode: boolean;
  /** "light" | "dark" — widgets (code highlight, mermaid) follow it. */
  colorScheme: 'light' | 'dark';
}

export type EditorCommand =
  | { kind: 'heading'; level: 0 | 1 | 2 | 3 | 4 | 5 | 6 } // 0 = paragraph
  | { kind: 'mark'; mark: 'strong' | 'em' | 'code' | 'strike' | 'highlight' | 'link' }
  | { kind: 'block'; block: 'quote' | 'ul' | 'ol' | 'task' | 'code' | 'math' | 'table' | 'hr' | 'toc' | 'front_matter' }
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
  | 'undo' | 'redo' | 'find' | 'replace'
  | 'toggleSidebar' | 'toggleSource' | 'toggleFocus' | 'toggleTypewriter' | 'quickOpen'
  | 'zoomIn' | 'zoomOut' | 'zoomReset'
  | `heading:${0 | 1 | 2 | 3 | 4 | 5 | 6}`
  | `mark:${'strong' | 'em' | 'code' | 'strike' | 'highlight' | 'link'}`
  | `block:${'quote' | 'ul' | 'ol' | 'task' | 'code' | 'math' | 'table' | 'hr' | 'toc'}`
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
}
