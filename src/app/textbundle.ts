/**
 * TextBundle support (#157, typora-re images §3.1/§3.2, fe-sidebar §1/§5/§11):
 * a `.textbundle` folder is one document — it opens like a file, images
 * inserted into it are copied to `<bundle>/assets`, and paths inside it are
 * relative to the bundle root. `.textpack` is not documented in the prose
 * (typora-re#14) and is not treated specially.
 */
import { dirname, normalize } from './util/path';

export const TEXTBUNDLE_EXT = '.textbundle';
/** Fixed image storage folder inside a bundle (images §3.1 priority 1). */
export const TEXTBUNDLE_ASSETS = 'assets';

/** True when `path`'s last component ends in `.textbundle` (case-insensitive). */
export function isTextBundlePath(path: string | null | undefined): boolean {
  return !!path && path.toLowerCase().endsWith(TEXTBUNDLE_EXT);
}

/**
 * The directory a document's relative paths resolve against: the bundle root
 * for a TextBundle (`assets/x.png`, not `<bundle>/assets/x.png` from the
 * parent), the file's own folder otherwise.
 */
export function docBaseDir(docPath: string): string {
  return isTextBundlePath(docPath) ? normalize(docPath) : dirname(docPath);
}

/** Markdown ↔ TextBundle renames are refused (fe-sidebar §5) unless empty. */
export const RENAME_MD_TO_BUNDLE =
  'Cannot rename from Markdown file to TextBundle file, please use "File" → "Move To…" from menubar instead.';
export const RENAME_BUNDLE_TO_MD =
  'Cannot rename from TextBundle file to Markdown file, please use "File" → "Move To…" from menubar instead.';
