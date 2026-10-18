/** Image srcs in markdown that may need relocating after the first save (local paths, not URLs). */
export function localImageSrcs(md: string): string[] {
  const out = new Set<string>();
  for (const m of md.matchAll(/!\[[^\]]*\]\(\s*(?:<([^>\n]+)>|([^)\s]+))(?:\s+"[^"]*")?\s*\)/g)) out.add(m[1] ?? m[2]);
  for (const m of md.matchAll(/<img\b[^>]*\bsrc\s*=\s*["']([^"']+)["']/gi)) out.add(m[1]);
  return [...out].filter((s) => s.startsWith('file:') || !/^(?:[a-z][a-z0-9+.-]*:|#)/i.test(s));
}
