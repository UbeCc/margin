import { h } from '../util/dom';
import { diffLines, diffStats, foldContext, type DiffRow } from '../util/linediff';
import { openModal } from './modal';

export type DiffChoice = 'keep' | 'load' | 'close';

/** Rows rendered at most; beyond this the diff says how much was omitted. */
const MAX_ROWS = 4000;

export function row(r: DiffRow): HTMLElement {
  if (r.kind === 'skip') {
    return h('div.extdiff-row.extdiff-skip', null, h('span.extdiff-gutter'), h('span.extdiff-gutter'), h('span.extdiff-sign'), h('span.extdiff-text', { text: `⋯ ${r.count} unchanged line${r.count === 1 ? '' : 's'}` }));
  }
  const a = r.kind === 'add' ? '' : String(r.a + 1);
  const b = r.kind === 'del' ? '' : String(r.b + 1);
  const sign = r.kind === 'add' ? '+' : r.kind === 'del' ? '−' : ' ';
  return h(
    `div.extdiff-row.extdiff-${r.kind}`,
    null,
    h('span.extdiff-gutter', { text: a }),
    h('span.extdiff-gutter', { text: b }),
    h('span.extdiff-sign', { text: sign, 'aria-hidden': 'true' }),
    // Empty lines still need height.
    h('span.extdiff-text', { text: r.text === '' ? ' ' : r.text }),
  );
}

/**
 * Modal with a line diff of the disk version (−) against the buffer (+), and the same
 * choices as the banner. Resolves 'close' on Escape / backdrop.
 */
export function openExternalDiff(opts: { name: string; disk: string; mine: string }): Promise<DiffChoice> {
  const ops = diffLines(opts.disk, opts.mine);
  const stats = diffStats(ops);
  const rows = foldContext(ops, 3);
  const shown = rows.slice(0, MAX_ROWS);
  return new Promise((resolve) => {
    let done = false;
    const finish = (c: DiffChoice): void => {
      if (done) return;
      done = true;
      modal.close();
      resolve(c);
    };
    const btn = (id: DiffChoice, label: string, cls = ''): HTMLButtonElement =>
      h('button.btn', { type: 'button', class: cls || null, 'data-id': id, text: label, onclick: () => finish(id) });
    const same = stats.added === 0 && stats.removed === 0;
    const body = h(
      'div.extdiff',
      null,
      h(
        'div.extdiff-head',
        null,
        h('h2.dialog-title', { text: `“${opts.name}”: disk vs. your version` }),
        h(
          'p.extdiff-legend',
          null,
          h('span.extdiff-badge.extdiff-badge-del', { text: `− ${stats.removed} on disk only` }),
          h('span.extdiff-badge.extdiff-badge-add', { text: `+ ${stats.added} in your version` }),
        ),
      ),
      h(
        'div.extdiff-body',
        { role: 'region', 'aria-label': 'Line differences', tabindex: '0' },
        same ? h('div.extdiff-empty', { text: 'The contents are identical (only line endings or nothing differ).' }) : shown.map(row),
        rows.length > shown.length ? h('div.extdiff-empty', { text: `${rows.length - shown.length} more rows not shown.` }) : null,
      ),
      h('div.dialog-buttons', null, btn('close', 'Close'), btn('load', 'Load Disk Version'), btn('keep', 'Keep Mine', 'btn-primary')),
    );
    const modal = openModal(body, { className: 'extdiff-card', onDismiss: () => finish('close'), label: `Differences in ${opts.name}` });
    (body.querySelector('[data-id=keep]') as HTMLElement | null)?.focus();
  });
}
