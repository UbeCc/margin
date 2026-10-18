import type { ExternalChange } from '../document';
import { h, icon } from '../util/dom';
import { openExternalDiff } from './extchange-diff';
import { toast } from './toast';
import './extchange.css';

/**
 * Non-blocking "File changed on disk" banner (#82), shown above the editor while the
 * document is dirty. Keep Mine / Load Disk / Show Diff; editing continues meanwhile.
 */
export class ExternalChangeBanner {
  readonly el: HTMLElement;
  private current: ExternalChange | null = null;
  private msg: HTMLElement;

  constructor() {
    this.msg = h('span.extchange-msg');
    const btn = (id: string, label: string, run: () => void, cls = ''): HTMLButtonElement =>
      h('button.btn.btn-small', { type: 'button', class: cls || null, 'data-id': id, text: label, onclick: run });
    this.el = h(
      'div.extchange-banner',
      { role: 'alert', hidden: true },
      icon('refresh', 'extchange-icon'),
      this.msg,
      h(
        'span.extchange-actions',
        null,
        btn('diff', 'Show Diff', () => void this.showDiff()),
        btn('load', 'Load Disk', () => this.load()),
        btn('keep', 'Keep Mine', () => this.keep(), 'btn-primary'),
      ),
    );
  }

  get visible(): boolean {
    return this.current !== null;
  }

  /** DocumentHost.externalChange */
  show(change: ExternalChange | null): void {
    this.current = change;
    this.el.hidden = !change;
    if (change) {
      this.msg.textContent = '';
      this.msg.append(h('strong', { text: `“${change.name}”` }), ' changed on disk. You have unsaved edits.');
    }
  }

  private keep(): void {
    this.current?.keepMine();
  }

  private load(): void {
    const c = this.current;
    if (!c) return;
    const undo = c.loadDisk();
    if (undo) toast(`Loaded the disk version of ${c.name}`, { kind: 'info', timeout: 8000, action: { label: 'Undo', run: undo } });
  }

  private async showDiff(): Promise<void> {
    const c = this.current;
    if (!c) return;
    const choice = await openExternalDiff({ name: c.name, disk: c.disk, mine: c.mine() });
    // The prompt may have been superseded while the diff was open; the change object guards itself.
    if (choice === 'keep') c.keepMine();
    else if (choice === 'load' && this.current === c) this.load();
  }
}
