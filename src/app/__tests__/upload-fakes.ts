import type { EditorCommand, EditorHandle } from '../../contracts';

/** Minimal editor whose replace-all mirrors the core: case-insensitive, whole document. */
export function fakeEditor(md: string): EditorHandle & { calls: EditorCommand[] } {
  let text = md;
  const calls: EditorCommand[] = [];
  const ed = {
    calls,
    getMarkdown: () => text,
    setMarkdown: (m: string) => void (text = m),
    exec(cmd: EditorCommand): boolean {
      calls.push(cmd);
      if (cmd.kind !== 'replace' || !cmd.all) return false;
      const re = new RegExp(cmd.query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
      const next = text.replace(re, () => cmd.replacement);
      if (next === text) return false;
      text = next;
      return true;
    },
    focus(): void {},
  };
  return ed as unknown as EditorHandle & { calls: EditorCommand[] };
}
