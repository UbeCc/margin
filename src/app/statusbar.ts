import type { EditorStats } from '../contracts';
import type { Eol } from './document';
import { h, icon } from './util/dom';
import { formatShortcut } from './util/keymap';

export interface StatusBarHandlers {
  toggleSidebar(): void;
  toggleSource(): void;
  toggleEol(): void;
}

type CountMode = 'words' | 'characters' | 'lines';

export class StatusBar {
  readonly el: HTMLElement;
  private countBtn: HTMLButtonElement;
  private eolBtn: HTMLButtonElement;
  private sourceBtn: HTMLButtonElement;
  private sidebarBtn: HTMLButtonElement;
  private saveState: HTMLElement;
  private modes: HTMLElement;
  private mode: CountMode = 'words';
  private stats: EditorStats = { words: 0, characters: 0, lines: 0 };

  constructor(handlers: StatusBarHandlers) {
    this.sidebarBtn = h('button.status-btn.sidebar-toggle', { type: 'button', title: `Toggle Sidebar (${formatShortcut('Mod+\\')})`, 'aria-label': 'Toggle Sidebar', onclick: handlers.toggleSidebar }, icon('sidebar'));
    this.sourceBtn = h('button.status-btn.source-toggle', { type: 'button', title: `Source Code Mode (${formatShortcut('Mod+/')})`, 'aria-label': 'Source Code Mode', 'aria-pressed': 'false', onclick: handlers.toggleSource }, icon('code'));
    this.countBtn = h('button.status-btn.word-count', { type: 'button', title: 'Click to switch between words, characters and lines', onclick: () => this.cycle() });
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

  private cycle(): void {
    this.mode = this.mode === 'words' ? 'characters' : this.mode === 'characters' ? 'lines' : 'words';
    this.render();
  }

  setStats(s: EditorStats): void {
    this.stats = s;
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

  private render(): void {
    const n = this.stats[this.mode];
    const unit = this.mode === 'words' ? 'word' : this.mode === 'characters' ? 'character' : 'line';
    this.countBtn.textContent = `${n.toLocaleString()} ${unit}${n === 1 ? '' : 's'}`;
  }
}
