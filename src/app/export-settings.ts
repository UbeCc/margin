/**
 * Export settings (#95, `typora.export.settings`): per-format options persisted in
 * the settings object under `export`, plus the per-document YAML overrides and the
 * variable expansion used by headers / footers / file names.
 */
import type { ImageFormat, ImageQuality } from './export-image';

/** `default` = no paper in the export settings: File › Page Setup decides (Typora's "Default"). */
export type PaperName = 'default' | 'A5' | 'A4' | 'A3' | 'Letter' | 'Legal' | 'Tabloid' | 'custom';
export type NamedPaper = Exclude<PaperName, 'default' | 'custom'>;
export type Orientation = 'portrait' | 'landscape';
export type PageBreaks = 'none' | 'h1' | 'h2';

/**
 * PDF page geometry from Preferences › Export › PDF (lengths in mm). Typora: a non-empty
 * paper here wins over File › Page Setup; margins always come from here (Page Setup
 * has none); orientation only from Page Setup (`orientation` is the resolved value
 * in `effectivePage`, ignored in the stored settings).
 */
export interface PageSetup {
  paper: PaperName;
  /** Custom paper [width, height] in mm (used when paper = 'custom'). */
  custom: [number, number];
  orientation: Orientation;
  /** 'default' = 45 pt top/bottom, 36 pt left/right. */
  marginMode: 'default' | 'custom';
  margins: { top: number; right: number; bottom: number; left: number };
}

/** File › Page Setup (session-only, like Typora's shared NSPrintInfo; not saved in settings). */
export interface PrintSetup {
  paper: Exclude<PaperName, 'default'>;
  custom: [number, number];
  orientation: Orientation;
}

export interface ExportSettings {
  general: {
    /** Where the save panel starts: 'last' = Typora's "Auto" (last export folder, else the document's), 'same' = the document's folder, 'custom'. */
    folder: 'same' | 'custom' | 'last';
    customFolder: string;
    /** After a successful export. */
    afterExport: 'none' | 'open' | 'reveal';
    /** Read title/author/header/footer… overrides from the document's YAML front matter. */
    allowYamlOverrides: boolean;
    /** Skip the confirmation before "Export and Overwrite with Previous". */
    noOverwriteWarning: boolean;
    /** Command run after every successful export ('' = none); `${outputPath}` etc. expanded per argv token. */
    runAfterExport: string;
  };
  /** User-defined export commands (File › Export › Custom). */
  custom: CustomExport[];
  pdf: {
    page: PageSetup;
    /** Theme used for the export ('' = current theme). */
    theme: string;
    pageBreaks: PageBreaks;
    header: string;
    footer: string;
    /** Add a bookmark outline built from the headings. */
    outline: boolean;
    author: string;
    /** "Append Extra Content (HTML)" at the end of the body. */
    appendBody: string;
  };
  html: { theme: string; appendHead: string; appendBody: string };
  htmlPlain: { appendHead: string; appendBody: string };
  image: { width: number; quality: ImageQuality; format: ImageFormat; theme: string; fontSize: number };
  pandoc: Record<PandocFormatId, PandocFormatOptions>;
}

/** Pandoc writers offered under File › Export (#81/#95). */
export const PANDOC_FORMAT_IDS = ['docx', 'odt', 'rtf', 'epub', 'latex', 'mediawiki', 'rst', 'textile', 'opml'] as const;
export type PandocFormatId = (typeof PANDOC_FORMAT_IDS)[number];

/**
 * Per-format Pandoc options (#90). Typora's settings page offers: docx `reference-doc`,
 * odt `template`, epub `css` + `epub-chapter-level` (1–4), and extra arguments for
 * every format; every field maps to one pandoc flag (`''`/0 = not passed).
 */
export interface PandocFormatOptions {
  referenceDoc: string;
  template: string;
  css: string;
  /** 0 = pandoc's default. */
  epubChapterLevel: number;
  /** Shell-style quoting; `${outputPath}` `${outputFolder}` `${currentFolder}` `${title}` expanded per token. */
  extraArguments: string;
}

/** Which option fields each format shows (Typora's per-type field table). */
export const PANDOC_FORMAT_FIELDS: Record<PandocFormatId, (keyof PandocFormatOptions)[]> = {
  docx: ['extraArguments', 'referenceDoc'],
  odt: ['extraArguments', 'template'],
  epub: ['extraArguments', 'css', 'epubChapterLevel'],
  rtf: ['extraArguments'],
  latex: ['extraArguments'],
  mediawiki: ['extraArguments'],
  rst: ['extraArguments'],
  textile: ['extraArguments'],
  opml: ['extraArguments'],
};

export const DEFAULT_PANDOC_OPTIONS: Readonly<PandocFormatOptions> = Object.freeze({ referenceDoc: '', template: '', css: '', epubChapterLevel: 0, extraArguments: '' });

export interface CustomExport {
  id: string;
  name: string;
  /** Command line; tokenized to argv (no shell), then `${vars}` expanded per token. */
  command: string;
  /** Output extension for the save panel ('' with saveDialog=false). */
  extension: string;
  /** What the command receives on stdin. */
  input: 'markdown' | 'html';
  /** Ask for an output path first (`${outputPath}`); false = the command decides. */
  saveDialog: boolean;
}

/** "Add From a Template" presets for custom exports. */
export const CUSTOM_EXPORT_TEMPLATES: Omit<CustomExport, 'id'>[] = [
  { name: 'PDF via Pandoc (xelatex)', command: 'pandoc -f markdown -o ${outputPath} --pdf-engine=xelatex --resource-path ${currentFolder}', extension: 'pdf', input: 'markdown', saveDialog: true },
  { name: 'PDF via wkhtmltopdf', command: 'wkhtmltopdf --enable-local-file-access - ${outputPath}', extension: 'pdf', input: 'html', saveDialog: true },
  { name: 'Markdown copy', command: 'tee ${outputPath}', extension: 'md', input: 'markdown', saveDialog: true },
  { name: 'Pandoc (custom format)', command: 'pandoc -f markdown -t asciidoc -s -o ${outputPath}', extension: 'adoc', input: 'markdown', saveDialog: true },
];

export const PAPER_SIZES: Record<NamedPaper, [number, number]> = {
  A3: [297, 420],
  A4: [210, 297],
  A5: [148, 210],
  Letter: [215.9, 279.4],
  Legal: [215.9, 355.6],
  Tabloid: [279.4, 431.8],
};

/** Preferences › Export › PDF paper choices, in Typora's order. */
export const PAPER_LABELS: [PaperName, string][] = [
  ['default', 'Default'],
  ['A5', 'A5'],
  ['A4', 'A4'],
  ['A3', 'A3'],
  ['Letter', 'US Letter'],
  ['Legal', 'US Legal'],
  ['Tabloid', 'Tabloid'],
  ['custom', 'Custom'],
];

const PT_TO_MM = 25.4 / 72;
/** Typora's default margins: 45 pt top/bottom, 36 pt left/right. */
export const DEFAULT_MARGINS = Object.freeze({ top: 45 * PT_TO_MM, right: 36 * PT_TO_MM, bottom: 45 * PT_TO_MM, left: 36 * PT_TO_MM });

export const DEFAULT_PAGE: Readonly<PageSetup> = Object.freeze({
  paper: 'default',
  custom: [210, 297] as [number, number],
  orientation: 'portrait',
  marginMode: 'default',
  margins: { ...DEFAULT_MARGINS },
});

export const DEFAULT_PRINT_SETUP: Readonly<PrintSetup> = Object.freeze({ paper: 'A4', custom: [210, 297] as [number, number], orientation: 'portrait' });

/** Preset menus of the PDF Header / Footer fields (empty = "None"). */
export const HEADER_PRESETS = ['${title}', '${author}', '${pageNo}', '${today}'];
export const FOOTER_PRESETS = ['${title}', 'No. ${pageNo} / ${totalPages}', 'Written in Margin', 'CONFIDENTIAL'];

/** Geometry actually used for print / PDF: export settings over Page Setup. */
export function effectivePage(pdf: PageSetup, ps: PrintSetup = DEFAULT_PRINT_SETUP): PageSetup {
  const own = pdf.paper !== 'default';
  return {
    paper: own ? pdf.paper : ps.paper,
    custom: own ? pdf.custom : ps.custom,
    orientation: ps.orientation,
    marginMode: 'custom',
    margins: pdf.marginMode === 'custom' ? { ...pdf.margins } : { ...DEFAULT_MARGINS },
  };
}

export const DEFAULT_EXPORT: Readonly<ExportSettings> = Object.freeze({
  general: { folder: 'last', customFolder: '', afterExport: 'none', allowYamlOverrides: true, noOverwriteWarning: false, runAfterExport: '' },
  custom: [],
  pdf: { page: DEFAULT_PAGE, theme: '', pageBreaks: 'none', header: '', footer: '', outline: true, author: '', appendBody: '' },
  html: { theme: '', appendHead: '', appendBody: '' },
  htmlPlain: { appendHead: '', appendBody: '' },
  image: { width: 800, quality: 'high', format: 'png', theme: '', fontSize: 16 },
  pandoc: Object.fromEntries(PANDOC_FORMAT_IDS.map((f) => [f, DEFAULT_PANDOC_OPTIONS])) as Record<PandocFormatId, PandocFormatOptions>,
}) as ExportSettings;

type Raw = Record<string, unknown>;
const obj = (v: unknown): Raw => (typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Raw) : {});
const s = (v: unknown, d: string): string => (typeof v === 'string' ? v : d);
const b = (v: unknown, d: boolean): boolean => (typeof v === 'boolean' ? v : d);
const n = (v: unknown, d: number, min: number, max: number): number => {
  const x = typeof v === 'string' ? parseFloat(v) : v;
  return typeof x === 'number' && Number.isFinite(x) ? Math.min(max, Math.max(min, x)) : d;
};
const oneOf = <T extends string>(v: unknown, all: readonly T[], d: T): T => (all.includes(v as T) ? (v as T) : d);

const PAPERS = ['default', 'A5', 'A4', 'A3', 'Letter', 'Legal', 'Tabloid', 'custom'] as const;

export function migratePageSetup(input: unknown): PageSetup {
  const r = obj(input);
  const d = DEFAULT_PAGE;
  const m = obj(r.margins);
  const c = Array.isArray(r.custom) ? r.custom : [];
  const margins = {
    top: n(m.top, d.margins.top, 0, 100),
    right: n(m.right, d.margins.right, 0, 100),
    bottom: n(m.bottom, d.margins.bottom, 0, 100),
    left: n(m.left, d.margins.left, 0, 100),
  };
  // Settings saved before "Default" existed: A4 + 16/13 mm was the old default.
  const legacy = r.marginMode === undefined && 'paper' in r;
  const oldDefaultMargins = margins.top === 16 && margins.bottom === 16 && margins.left === 13 && margins.right === 13;
  let paper = oneOf(r.paper, PAPERS, d.paper);
  if (legacy && r.paper === 'A4') paper = 'default';
  return {
    paper,
    custom: [n(c[0], d.custom[0], 50, 2000), n(c[1], d.custom[1], 50, 2000)],
    orientation: oneOf(r.orientation, ['portrait', 'landscape'] as const, d.orientation),
    marginMode: legacy ? (oldDefaultMargins || m.top === undefined ? 'default' : 'custom') : oneOf(r.marginMode, ['default', 'custom'] as const, 'default'),
    margins: legacy && oldDefaultMargins ? { ...DEFAULT_MARGINS } : margins,
  };
}

export function migratePrintSetup(input: unknown): PrintSetup {
  const r = obj(input);
  const d = DEFAULT_PRINT_SETUP;
  const c = Array.isArray(r.custom) ? r.custom : [];
  return {
    paper: oneOf(r.paper, ['A5', 'A4', 'A3', 'Letter', 'Legal', 'Tabloid', 'custom'] as const, d.paper),
    custom: [n(c[0], d.custom[0], 50, 2000), n(c[1], d.custom[1], 50, 2000)],
    orientation: oneOf(r.orientation, ['portrait', 'landscape'] as const, d.orientation),
  };
}

export function migratePandocOptions(input: unknown): Record<PandocFormatId, PandocFormatOptions> {
  const r = obj(input);
  const out = {} as Record<PandocFormatId, PandocFormatOptions>;
  for (const f of PANDOC_FORMAT_IDS) {
    const o = obj(r[f]);
    out[f] = {
      referenceDoc: s(o.referenceDoc, ''),
      template: s(o.template, ''),
      css: s(o.css, ''),
      epubChapterLevel: Math.round(n(o.epubChapterLevel, 0, 0, 4)),
      extraArguments: s(o.extraArguments, ''),
    };
  }
  return out;
}

export function migrateCustomExports(v: unknown): CustomExport[] {
  if (!Array.isArray(v)) return [];
  const seen = new Set<string>();
  const out: CustomExport[] = [];
  for (const x of v.slice(0, 50)) {
    const c = obj(x);
    let id = typeof c.id === 'string' && /^[\w-]{1,40}$/.test(c.id) ? c.id : '';
    if (!id || seen.has(id)) id = `c${out.length + 1}-${Math.random().toString(36).slice(2, 8)}`;
    seen.add(id);
    out.push({
      id,
      name: s(c.name, '').trim() || 'Custom export',
      command: s(c.command, ''),
      extension: s(c.extension, '').replace(/^\.+/, '').replace(/[^\w.-]/g, '').slice(0, 16),
      input: oneOf(c.input, ['markdown', 'html'] as const, 'markdown'),
      saveDialog: b(c.saveDialog, true),
    });
  }
  return out;
}

/** Validate + default the persisted `export` settings object. Never throws. */
export function migrateExportSettings(input: unknown): ExportSettings {
  const r = obj(input);
  const d = DEFAULT_EXPORT;
  const g = obj(r.general);
  const p = obj(r.pdf);
  const hh = obj(r.html);
  const hp = obj(r.htmlPlain);
  const im = obj(r.image);
  return {
    general: {
      folder: oneOf(g.folder, ['same', 'custom', 'last'] as const, d.general.folder),
      customFolder: s(g.customFolder, ''),
      afterExport: oneOf(g.afterExport, ['none', 'open', 'reveal'] as const, d.general.afterExport),
      allowYamlOverrides: b(g.allowYamlOverrides, d.general.allowYamlOverrides),
      noOverwriteWarning: b(g.noOverwriteWarning, false),
      runAfterExport: s(g.runAfterExport, ''),
    },
    custom: migrateCustomExports(r.custom),
    pdf: {
      page: migratePageSetup(p.page),
      theme: s(p.theme, ''),
      pageBreaks: oneOf(p.pageBreaks, ['none', 'h1', 'h2'] as const, 'none'),
      header: s(p.header, ''),
      footer: s(p.footer, ''),
      outline: b(p.outline, true),
      author: s(p.author, ''),
      appendBody: s(p.appendBody, ''),
    },
    html: { theme: s(hh.theme, ''), appendHead: s(hh.appendHead, ''), appendBody: s(hh.appendBody, '') },
    htmlPlain: { appendHead: s(hp.appendHead, ''), appendBody: s(hp.appendBody, '') },
    image: {
      width: Math.round(n(im.width, d.image.width, 200, 4000)),
      quality: oneOf(im.quality, ['medium', 'high', 'best'] as const, d.image.quality),
      format: oneOf(im.format, ['png', 'jpeg'] as const, d.image.format),
      theme: s(im.theme, ''),
      fontSize: Math.round(n(im.fontSize, d.image.fontSize, 8, 48)),
    },
    pandoc: migratePandocOptions(r.pandoc),
  };
}

/** Quote one argv element for the read-only "Arguments" preview. */
function q(a: string): string {
  return /^[\w@%+=:,./${}-]+$/.test(a) ? a : `"${a.replace(/(["\\$`])/g, '\\$1')}"`;
}

/**
 * Read-only preview of the pandoc command line for one format (Typora shows the same
 * kind of disabled "Arguments" string). Mirrors `export_args` + `option_args` in
 * src-tauri/src/pandoc.rs; the real argv is rebuilt natively.
 */
export function pandocArgsPreview(format: PandocFormatId, o: PandocFormatOptions): string {
  const writer: Record<PandocFormatId, string> = { docx: 'docx', odt: 'odt', rtf: 'rtf -s', epub: 'epub', latex: 'latex -s', mediawiki: 'mediawiki', rst: 'rst -s', textile: 'textile', opml: 'opml -s' };
  const a = [`-f markdown -t ${writer[format]} -o \${outputPath}`];
  if (o.css.trim()) a.push(`--css ${q(o.css.trim())}`);
  if (o.referenceDoc.trim()) a.push(`--reference-doc ${q(o.referenceDoc.trim())}`);
  if (o.template.trim()) a.push(`--template ${q(o.template.trim())}`);
  if (o.epubChapterLevel > 0) a.push(`--epub-chapter-level=${o.epubChapterLevel}`);
  if (o.extraArguments.trim()) a.push(o.extraArguments.trim());
  return a.join(' ');
}

/** Paper size in mm after applying orientation ('default' alone: A4). */
export function paperSizeMm(page: Pick<PageSetup, 'paper' | 'custom' | 'orientation'>): [number, number] {
  const [w, h] = page.paper === 'custom' ? page.custom : PAPER_SIZES[page.paper === 'default' ? 'A4' : page.paper];
  return page.orientation === 'landscape' ? [Math.max(w, h), Math.min(w, h)] : [Math.min(w, h), Math.max(w, h)];
}

export const MM_TO_PT = 72 / 25.4;

/** `@page` CSS (size + margins) and optional page breaks, for print / PDF. */
export function pageCss(page: PageSetup, breaks: PageBreaks = 'none'): string {
  const [w, h] = paperSizeMm(page);
  const m = page.margins;
  const brk = breaks === 'none' ? '' : `\n  .margin-doc ${breaks === 'h2' ? 'h1, .margin-doc h2' : 'h1'} { break-before: page; }\n  .margin-doc > :first-child { break-before: auto !important; }`;
  return `@page { size: ${w}mm ${h}mm; margin: ${m.top}mm ${m.right}mm ${m.bottom}mm ${m.left}mm; }
@media print {${brk}
}`;
}

// ------------------------------------------------------------ YAML overrides

/** Minimal flat YAML front matter reader (scalars only; enough for export overrides). */
export function frontMatter(markdown: string): Record<string, string> {
  const m = /^---[ \t]*\r?\n([\s\S]*?)\r?\n(?:---|\.\.\.)[ \t]*(?:\r?\n|$)/.exec(markdown);
  const out: Record<string, string> = {};
  if (!m) return out;
  for (const line of m[1].split(/\r?\n/)) {
    const kv = /^([A-Za-z][\w-]*)[ \t]*:[ \t]*(.*?)[ \t]*$/.exec(line);
    if (!kv) continue;
    let v = kv[2];
    if (/^(['"]).*\1$/.test(v)) v = v.slice(1, -1);
    if (v === '|' || v === '>') continue;
    out[kv[1].toLowerCase()] = v;
  }
  return out;
}

export interface ExportMeta {
  title: string;
  author: string;
  subject: string;
  keywords: string;
  header?: string;
  footer?: string;
}

/**
 * Merge order (lowest → highest): computed title, export settings, YAML front
 * matter. Each key accepts `margin-<k>`, `typora-<k>` (compat) and `<k>`; the
 * value "unset" clears it.
 */
export function resolveMeta(markdown: string, base: { title: string; author: string; header: string; footer: string }, allowYaml: boolean): ExportMeta {
  const fm = allowYaml ? frontMatter(markdown) : {};
  const pick = (k: string, d: string): string => {
    for (const key of [`margin-${k}`, `typora-${k}`, k]) {
      if (key in fm) return fm[key] === 'unset' ? '' : fm[key];
    }
    return d;
  };
  const kw = pick('keywords', '') || pick('tags', '');
  return {
    title: pick('title', base.title),
    author: pick('author', base.author),
    subject: pick('subject', ''),
    keywords: kw.replace(/^\[|\]$/g, ''),
    header: pick('header', base.header),
    footer: pick('footer', base.footer),
  };
}

/**
 * Expand `${name}` variables. Unknown names stay literal (so `${pageNo}` /
 * `${totalPages}` survive for the per-page stage).
 */
export function expandVars(template: string, vars: Record<string, string>): string {
  return template.replace(/\$\{([\w.]+)\}/g, (all, k: string) => (Object.prototype.hasOwnProperty.call(vars, k) ? vars[k] : all));
}

export function todayString(d = new Date()): string {
  const p = (x: number): string => String(x).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
