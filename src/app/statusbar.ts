import type { Eol } from './document';
import { h, icon } from './util/dom';
import { formatShortcut } from './util/keymap';
import { showContextMenu, type MenuItem } from './ui/contextmenu';
import { formatCount, readingMinutes, unitLabel, type Counts, type CountUnit } from './wordcount';

export interface StatusBarHandlers {
  toggleSidebar(): void;
  toggleSource(): void;
  toggleEol(): void;
  /** The user picked another unit in the word-count popover. */
  setUnit(unit: CountUnit): void;
}

export interface SelectionCounts {
  words: number;
  characters: number;
}

/**
 * Status bar (#103, `typora.menu.view.status-bar`): sidebar / source toggles, save
 * state, line endings, and the word count. The count shows the chosen unit
 * ("N Words", or "sel / total Words" with a partial selection — words and
 * characters only); clicking it opens the Word Count popover (words, reading
 * time, lines, characters, plus "In Selection").
 */
export class StatusBar {
  readonly el: HTMLElement;
  /** Floating copy of the count, shown by "Always Show Word Count" while the bar is hidden. */
  readonly floating: HTMLButtonElement;
  private countBtn: HTMLButtonElement;
  private eolBtn: HTMLButtonElement;
  private sourceBtn: HTMLButtonElement;
  private sidebarBtn: HTMLButtonElement;
  private saveState: HTMLElement;
  private modes: HTMLElement;
  private unit: CountUnit = 'words';
  private wpm = 382;
  private stats: Counts = { words: 0, characters: 0, lines: 1 };
  private sel: SelectionCounts | null = null;

  constructor(private handlers: StatusBarHandlers) {
    this.sidebarBtn = h('button.status-btn.sidebar-toggle', { type: 'button', title: `Toggle Sidebar (${formatShortcut('Mod+\\')})`, 'aria-label': 'Toggle Sidebar', onclick: handlers.toggleSidebar }, icon('sidebar'));
    this.sourceBtn = h('button.status-btn.source-toggle', { type: 'button', title: `Source Code Mode (${formatShortcut('Mod+/')})`, 'aria-label': 'Source Code Mode', 'aria-pressed': 'false', onclick: handlers.toggleSource }, icon('code'));
    this.countBtn = h('button.status-btn.word-count', { type: 'button', title: 'Word Count', 'aria-haspopup': 'menu', onclick: () => this.openPopover(this.countBtn) });
    this.floating = h('button.status-btn.word-count.word-count-floating', { type: 'button', title: 'Word Count', 'aria-haspopup': 'menu', onclick: () => this.openPopover(this.floating) });
    this.eolBtn = h('button.status-btn.eol', { type: 'button', title: 'Line endings (click to switch)', onclick: handlers.toggleEol });
    this.saveState = h('span.status-save');
    this.modes = h('span.status-modes');
    this.el = h(
      'footer.statusbar',
      null,
      h('div.status-left', null, this.sidebarBtn, this.sourceBtn, this.modes),
      h('div.status-right', null, this.saveState, this.eolBtn, this.countBtn),
    );
    this.render();
  }

  get countText(): string {
    return this.countBtn.textContent ?? '';
  }

  setUnit(unit: CountUnit): void {
    this.unit = unit;
    this.render();
  }

  setReadingSpeed(wpm: number): void {
    this.wpm = wpm;
    this.render();
  }

  setStats(s: Counts): void {
    this.stats = s;
    this.render();
  }

  /** Partial selection counts, or null when nothing (or everything) is selected. */
  setSelection(s: SelectionCounts | null): void {
    this.sel = s && s.characters > 0 ? s : null;
    this.render();
  }

  setEol(eol: Eol): void {
    this.eolBtn.textContent = eol === '\n' ? 'LF' : 'CRLF';
  }

  setSource(on: boolean): void {
    this.sourceBtn.classList.toggle('on', on);
    this.sourceBtn.setAttribute('aria-pressed', String(on));
  }

  setModes(m: { focus: boolean; typewriter: boolean }): void {
    this.modes.textContent = [m.focus ? 'Focus' : '', m.typewriter ? 'Typewriter' : ''].filter(Boolean).join(' · ');
  }

  setSaveState(text: string, kind: 'saved' | 'dirty' | 'missing' | '' = ''): void {
    this.saveState.textContent = text;
    this.saveState.dataset.kind = kind;
  }

  private value(unit: CountUnit): number {
    return unit === 'minutes' ? readingMinutes(this.stats.words, this.wpm) : this.stats[unit];
  }

  private render(): void {
    const u = this.unit;
    const total = this.value(u);
    let text = formatCount(total, u);
    if (this.sel && (u === 'words' || u === 'characters')) text = `${this.sel[u].toLocaleString('en-US')} / ${total.toLocaleString('en-US')} ${unitLabel(total, u)}`;
    this.countBtn.textContent = text;
    this.floating.textContent = text;
  }

  /** Word Count popover: four totals in Typora's fixed order Minutes, Lines, Words, Characters
   * (native-window-touchbar §3.4/§3.9), then "In Selection" words / characters. */
  openPopover(anchor: HTMLElement = this.countBtn): void {
    const row = (unit: CountUnit, n: number): MenuItem => ({
      label: formatCount(n, unit),
      checked: this.unit === unit,
      run: () => {
        this.setUnit(unit);
        this.handlers.setUnit(unit);
      },
    });
    const items: MenuItem[] = [
      row('minutes', this.value('minutes')),
      row('lines', this.stats.lines),
      row('words', this.stats.words),
      row('characters', this.stats.characters),
    ];
    if (this.sel) {
      items.push(
        { separator: true },
        { label: 'In Selection', disabled: true, run: () => undefined },
        { label: formatCount(this.sel.words, 'words'), run: () => this.handlers.setUnit('words') },
        { label: formatCount(this.sel.characters, 'characters'), run: () => this.handlers.setUnit('characters') },
      );
    }
    const r = anchor.getBoundingClientRect();
    showContextMenu(r.left, r.top - 8 - 26 * items.length, items);
  }
}
