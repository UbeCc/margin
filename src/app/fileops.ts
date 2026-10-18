import type { Platform } from '../contracts';
import type { DocTabs } from './doctabs';
import type { DraftSlot, DraftStore } from './drafts';
import { encodingLabel, ENCODINGS } from './encoding';
import { extras } from './platform-extras';
import { row } from './ui/extchange-diff';
import { ask, openModal, promptDialog } from './ui/modal';
import { openPalette } from './ui/palette';
import { toast } from './ui/toast';
import type { Version, VersionStore } from './versions';
import { diffLines, diffStats, foldContext } from './util/linediff';
import { h } from './util/dom';
import { basename, dirname, displayPath, join, stripExt } from './util/path';
import './fileops.css';

export interface FileOpsHost {
  readonly platform: Platform;
  readonly docs: DocTabs;
  readonly versions: VersionStore;
  readonly drafts: DraftStore;
  /** A file was renamed / moved on disk by us (tree, recent list, history follow). */
  renamed(from: string, to: string): void;
}

const fmtSize = (n: number): string =>
  n < 1024 ? `${n} bytes` : n < 1024 * 1024 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`;
const fmtTime = (t: number): string => new Date(t).toLocaleString();

/** File-menu operations on the current document (#94). */
export class FileOps {
  /** Drafts found at startup and not yet restored or dismissed. */
  pendingDrafts: DraftSlot[] = [];

  constructor(private host: FileOpsHost) {}

  private get doc() {
    return this.host.docs.active.doc;
  }

  private needsFile(what: string): string | null {
    const p = this.doc.path;
    if (!p) toast(`Save the document first to ${what}.`, { kind: 'info' });
    return p;
  }

  /** File › Duplicate: an untitled copy in a new tab, saved under "<name> copy". */
  duplicate(): boolean {
    const src = this.host.docs.active;
    const md = src.editor.getMarkdown();
    const name = src.doc.path ? `${stripExt(basename(src.doc.path))} copy` : undefined;
    const t = this.host.docs.newTab();
    t.doc.loadUnsaved(md, { suggestedName: name });
    t.editor.focus();
    return true;
  }

  /** File › Rename…: rename the open file in place (a new name only; Move To changes folders). */
  async rename(): Promise<boolean> {
    const from = this.doc.path;
    if (!from) return this.doc.saveAs();
    const mv = extras(this.host.platform).rename;
    if (!mv) return (toast('Renaming files is not supported here.', { kind: 'error' }), false);
    const name = await promptDialog({
      title: `Rename “${basename(from)}”`,
      value: basename(from),
      okLabel: 'Rename',
      selectStem: true,
      validate: (v) =>
        !v
          ? 'Enter a file name.'
          : /[\\/]/.test(v)
            ? `Cannot rename from ${basename(from)} to ${v}, please use “File” → “Move To…” instead.`
            : null,
    });
    if (!name || name === basename(from)) return false;
    return this.moveFile(from, join(dirname(from), name));
  }

  /** File › Move To…: pick a new location for the open file. */
  async moveTo(): Promise<boolean> {
    const from = this.doc.path;
    if (!from) return this.doc.saveAs();
    if (!extras(this.host.platform).rename) return (toast('Moving files is not supported here.', { kind: 'error' }), false);
    const to = await this.host.platform.saveFileDialog({ defaultPath: from, filters: [{ name: 'Markdown', extensions: ['md', 'markdown', 'txt'] }] });
    if (!to || to === from) return false;
    return this.moveFile(from, to);
  }

  private async moveFile(from: string, to: string): Promise<boolean> {
    if (await this.host.platform.stat(to).catch(() => null)) {
      toast(`File with the same name already exists at target path: ${displayPath(to)}`, { kind: 'error' });
      return false;
    }
    try {
      await extras(this.host.platform).rename!.call(this.host.platform, from, to);
    } catch (e) {
      toast(`Failed to rename from “${basename(from)}” to “${basename(to)}”: ${e instanceof Error ? e.message : e}`, { kind: 'error' });
      return false;
    }
    this.host.renamed(from, to);
    return true;
  }

  /** File › Reveal in Finder / Open File Location. */
  async reveal(): Promise<boolean> {
    const p = this.needsFile('show it in the file manager');
    const reveal = extras(this.host.platform).revealInFolder;
    if (!p || !reveal) return false;
    await reveal.call(this.host.platform, p).catch((e) => toast(`Couldn't reveal ${basename(p)}: ${e}`, { kind: 'error' }));
    return true;
  }

  /** File › Copy File Path. */
  async copyPath(): Promise<boolean> {
    const p = this.needsFile('copy its path');
    if (!p) return false;
    try {
      const w = extras(this.host.platform).writeClipboardText;
      if (w) await w.call(this.host.platform, p);
      else await navigator.clipboard.writeText(p);
      toast('File path copied', { kind: 'success', timeout: 1500 });
      return true;
    } catch (e) {
      toast(`Couldn't copy the path: ${e instanceof Error ? e.message : e}`, { kind: 'error' });
      return false;
    }
  }

  /** File › Properties: name, location, size, dates, counts, encoding, line endings. */
  async properties(): Promise<boolean> {
    const t = this.host.docs.active;
    const st = t.doc.path ? await this.host.platform.stat(t.doc.path).catch(() => null) : null;
    const s = t.editor.getStats();
    const rows: [string, string][] = [
      ['Name', t.doc.name],
      ['Location', t.doc.path ? displayPath(dirname(t.doc.path)) : 'Not saved'],
      ['Size', st ? fmtSize(st.size) : '—'],
      ['Modified', st ? fmtTime(st.mtime) : '—'],
      ['Words', s.words.toLocaleString()],
      ['Characters', s.characters.toLocaleString()],
      ['Lines', s.lines.toLocaleString()],
      ['Encoding', encodingLabel(t.doc.encoding)],
      ['Line Endings', t.doc.eol === '\r\n' ? 'CRLF (Windows)' : 'LF (Unix)'],
      ['Status', t.doc.missing ? 'Deleted on disk' : t.doc.dirty ? 'Modified' : 'Saved'],
    ];
    const body = h(
      'div.dialog.file-properties',
      null,
      h('h2.dialog-title', { text: `${t.doc.name} — Properties` }),
      h('dl.props', null, ...rows.flatMap(([k, v]) => [h('dt', { text: k }), h('dd', { 'data-prop': k.toLowerCase().replace(/\s+/g, '-'), text: v })])),
      h('div.dialog-buttons', null, h('button.btn.btn-primary', { type: 'button', text: 'Close', onclick: () => m.close() })),
    );
    const m = openModal(body, { className: 'dialog-card', label: 'Properties' });
    body.querySelector<HTMLElement>('.btn-primary')?.focus();
    return true;
  }

  /** File › Reopen with Encoding: pick an encoding, re-read the file's bytes with it. */
  reopenWithEncoding(): boolean {
    const p = this.needsFile('reopen it with another encoding');
    if (!p) return false;
    if (!extras(this.host.platform).readFileBytes) return (toast('Reading other encodings is not supported here.', { kind: 'error' }), false);
    const cur = this.doc.encoding;
    openPalette({
      className: 'encoding-picker',
      placeholder: `Reopen ${basename(p)} with encoding…`,
      provide: (q) =>
        ENCODINGS.filter((e) => !q || `${e.label} ${e.id}`.toLowerCase().includes(q.toLowerCase())).map((e) => ({
          id: e.id,
          label: e.label,
          detail: e.id === cur ? 'current' : undefined,
          kind: 'command' as const,
        })),
      pick: (it) => void this.doc.reopenWithEncoding(it.id),
    });
    return true;
  }

  /** File › Browse All Versions: saved versions of this file; restore = one undoable edit. */
  async browseVersions(): Promise<boolean> {
    const t = this.host.docs.active;
    const p = this.needsFile('keep versions of it');
    if (!p) return false;
    const versions = await this.host.versions.list(p);
    if (!versions.length) {
      toast(`No saved versions of ${basename(p)} yet.`, { kind: 'info' });
      return false;
    }
    const list = h('ul.versions-list', { role: 'listbox', 'aria-label': 'Versions' });
    const preview = h('div.extdiff-body.versions-preview', { role: 'region', 'aria-label': 'Changes against the current document', tabindex: '0' });
    const summary = h('p.extdiff-legend');
    let selected: { v: Version; text: string } | null = null;
    const restoreBtn = h('button.btn.btn-primary', { type: 'button', 'data-id': 'restore', text: 'Restore This Version', disabled: true });
    const select = async (v: Version, li: HTMLElement): Promise<void> => {
      for (const x of list.children) x.setAttribute('aria-selected', String(x === li));
      const text = await this.host.versions.read(v);
      selected = { v, text };
      const ops = diffLines(text, t.editor.getMarkdown());
      const st = diffStats(ops);
      summary.replaceChildren(
        h('span.extdiff-badge.extdiff-badge-del', { text: `− ${st.removed} only in this version` }),
        h('span.extdiff-badge.extdiff-badge-add', { text: `+ ${st.added} only in the current document` }),
      );
      preview.replaceChildren(
        ...(st.added || st.removed ? foldContext(ops, 3).slice(0, 2000).map(row) : [h('div.extdiff-empty', { text: 'Same as the current document.' })]),
      );
      restoreBtn.disabled = false;
    };
    versions.forEach((v, i) => {
      const li = h('li.versions-item', { role: 'option', tabindex: '0', 'data-time': String(v.time) }, h('span', { text: fmtTime(v.time) }), h('small', { text: i === 0 ? `${fmtSize(v.size)} · latest` : fmtSize(v.size) }));
      li.addEventListener('click', () => void select(v, li));
      list.append(li);
    });
    const body = h(
      'div.extdiff.versions',
      null,
      h('div.extdiff-head', null, h('h2.dialog-title', { text: `Versions of “${basename(p)}”` }), summary),
      h('div.versions-main', null, list, preview),
      h('div.dialog-buttons', null, h('button.btn', { type: 'button', text: 'Close', onclick: () => m.close() }), restoreBtn),
    );
    const m = openModal(body, { className: 'extdiff-card', label: `Versions of ${basename(p)}` });
    restoreBtn.addEventListener('click', () => {
      if (!selected) return;
      t.editor.exec({ kind: 'replaceDocument', markdown: selected.text });
      m.close();
      toast(`Restored the version from ${fmtTime(selected.v.time)} — undo to go back.`, { kind: 'success' });
    });
    await select(versions[0], list.firstElementChild as HTMLElement);
    return true;
  }

  /** General › Recover Unsaved Drafts: drafts left by windows that did not close cleanly. */
  async recoverDrafts(): Promise<boolean> {
    const slots = this.pendingDrafts.length ? this.pendingDrafts : await this.host.drafts.leftovers();
    const items = slots.flatMap((s) => s.drafts.map((d, i) => ({ s, d, id: `${s.file}#${i}` })));
    if (!items.length) {
      toast('No unsaved drafts to recover.', { kind: 'info' });
      return false;
    }
    openPalette({
      className: 'drafts-picker',
      placeholder: 'Recover an unsaved draft',
      provide: (q) =>
        items
          .filter((x) => !q || x.d.name.toLowerCase().includes(q.toLowerCase()))
          .map((x) => ({ id: x.id, label: x.d.name, detail: `${x.d.path ? displayPath(x.d.path) : 'Untitled'} · ${fmtTime(x.d.time)}`, kind: 'file' as const })),
      pick: (it) => {
        const x = items.find((y) => y.id === it.id);
        if (x) void this.restoreDraft(x.s, x.d);
      },
    });
    return true;
  }

  private async restoreDraft(slot: DraftSlot, d: { path: string | null; name: string; content: string }): Promise<void> {
    const docs = this.host.docs;
    if (d.path && (await this.host.platform.stat(d.path).catch(() => null))) {
      if (!(await docs.openPath(d.path, 'tab'))) return;
      const t = docs.active;
      if (t.doc.dirty) {
        const r = await ask({
          title: `“${t.doc.name}” has unsaved changes`,
          message: 'Replace them with the recovered draft?',
          buttons: [
            { id: 'cancel', label: 'Cancel' },
            { id: 'replace', label: 'Replace', primary: true },
          ],
          cancelId: 'cancel',
        });
        if (r !== 'replace') return;
      }
      t.editor.exec({ kind: 'replaceDocument', markdown: d.content });
    } else {
      const t = docs.active.doc.isPristine() ? docs.active : docs.newTab();
      t.doc.loadUnsaved(d.content, { suggestedName: d.path ? stripExt(basename(d.path)) : undefined });
    }
    slot.drafts = slot.drafts.filter((x) => x !== d);
    if (!slot.drafts.length) {
      await this.host.drafts.clear(slot);
      this.pendingDrafts = this.pendingDrafts.filter((s) => s !== slot);
    }
    toast(`Recovered “${d.name}”. Save it to keep it.`, { kind: 'success' });
  }
}
