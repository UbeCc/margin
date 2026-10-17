/**
 * Core document model types.
 *
 * The document is a flat list of *leaf* blocks. Every source line belongs to
 * exactly one leaf and is stored verbatim as `prefix + text + eol`, where
 * `prefix` is the container syntax consumed on that line (`> `, `- `, list
 * continuation indent …). Containers (block quotes, list items) are shared
 * objects referenced by each leaf's `chain`, so serialisation is simply the
 * concatenation of every line — lossless by construction.
 */

export interface Line {
  /** Container syntax consumed on this line (quote markers, list marker/indent). */
  prefix: string;
  /** The rest of the line (leaf content) without line ending. */
  text: string;
  /** '\n', '\r\n', '\r' or '' (last line of the document without newline). */
  eol: string;
}

export interface QuoteContainer {
  kind: 'quote';
  key: number;
}

export interface ItemContainer {
  kind: 'item';
  key: number;
  ordered: boolean;
  /** Bullet char ('-', '*', '+') or ordered delimiter ('.', ')'). */
  delim: string;
  /** Number written in the source (ordered lists). */
  start: number;
  /** Display number (ordered lists): computed from list position. */
  number: number;
  /** Item index inside its list (0 = first item). */
  index: number;
  /** Key shared by all items of the same list. */
  listKey: number;
  /** Task state: null = not a task, otherwise the char inside `[ ]`. */
  task: null | string;
  /** Content indentation in columns relative to the item's start column. */
  width: number;
  /** Exact marker text written on the first line (e.g. "- ", "12. "), excluding task box. */
  markerText: string;
}

export type Container = QuoteContainer | ItemContainer;

export type LeafType =
  | 'paragraph'
  | 'heading'
  | 'hr'
  | 'indented_code'
  | 'footnote'
  | 'def'
  | 'code_fence'
  | 'diagram'
  | 'math_block'
  | 'table'
  | 'html_block'
  | 'front_matter'
  | 'toc';

/** Leaf types edited as inline text in the contenteditable root. */
export const TEXT_TYPES: ReadonlySet<LeafType> = new Set<LeafType>([
  'paragraph',
  'heading',
  'indented_code',
  'footnote',
  'def',
]);

export function isTextType(t: LeafType): boolean {
  return TEXT_TYPES.has(t);
}

export interface Leaf {
  id: string;
  type: LeafType;
  /** All source lines of the leaf, including trailing blank lines. */
  lines: Line[];
  /** Number of content lines; lines[n..] are trailing blank lines. */
  n: number;
  /** Enclosing containers, outermost first. */
  chain: Container[];
  /** chain[openFrom..] were opened on this leaf's first line (list markers shown here). */
  openFrom: number;
  /** Heading level (ATX or setext). */
  level?: number;
  /** Setext heading (last content line is the underline). */
  setext?: boolean;
  /** Fence info string first word (lower-case). */
  lang?: string;
}

export type ParsedLeaf = Omit<Leaf, 'id'>;
