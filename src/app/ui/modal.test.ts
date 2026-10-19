// ui.generic (parity ledger): the generic dialog vocabulary — message box with N buttons and an
// optional suppression checkbox (Typora's `window.showDialog {message, buttons, checkbox}` shape),
// OK/Cancel confirm, text prompt; Escape / backdrop resolve as Cancel.
import { afterEach, describe, expect, it } from 'vitest';
import { ask, confirmDialog, promptDialog } from './modal';

const buttons = () => [...document.querySelectorAll<HTMLButtonElement>('.dialog-buttons button')];
const esc = () => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));

afterEach(() => document.body.replaceChildren());

describe('ui.generic: Generic dialog vocabulary (OK/Cancel/Yes/…, notices)', () => {
  it('ui.generic: confirm dialog shows Cancel / OK, OK resolves true, Escape resolves false', async () => {
    const p = confirmDialog('Delete file?', 'This cannot be undone.');
    expect(document.querySelector('[role=dialog]')?.getAttribute('aria-label')).toBe('Delete file?');
    expect(document.querySelector('.dialog-message')?.textContent).toBe('This cannot be undone.');
    expect(buttons().map((b) => b.textContent)).toEqual(['Cancel', 'OK']);
    expect(document.activeElement).toBe(buttons()[1]); // primary button focused
    buttons()[1].click();
    expect(await p).toBe(true);
    expect(document.querySelector('.modal-backdrop')).toBeNull();

    const q = confirmDialog('Discard?', undefined, 'Discard', true);
    expect(buttons().map((b) => b.textContent)).toEqual(['Cancel', 'Discard']);
    expect(buttons()[1].classList.contains('btn-danger')).toBe(true);
    esc();
    expect(await q).toBe(false);
  });

  it('ui.generic: message box with N buttons and a suppression checkbox returns [button, checked]', async () => {
    const p = ask({
      title: 'Notice',
      message: 'You could turn it off from `View` menu.',
      buttons: [
        { id: 'no', label: 'Cancel' },
        { id: 'yes', label: 'Yes', primary: true },
        { id: 'more', label: 'Learn More' },
      ],
      cancelId: 'no',
      checkbox: { label: 'Do not show again' },
    });
    expect(buttons().map((b) => b.textContent)).toEqual(['Cancel', 'Yes', 'Learn More']);
    const box = document.querySelector<HTMLInputElement>('.dialog-checkbox input')!;
    expect(box.checked).toBe(false);
    box.checked = true;
    box.dispatchEvent(new Event('change'));
    buttons()[2].click();
    expect(await p).toEqual({ id: 'more', checked: true });

    const q = ask({ title: 'Notice', buttons: [{ id: 'ok', label: 'OK' }], cancelId: 'ok' });
    esc(); // Escape resolves the cancel id
    expect(await q).toEqual({ id: 'ok', checked: false });
  });

  it('ui.generic: prompt dialog trims input, validates, Cancel resolves null', async () => {
    const p = promptDialog({ title: 'Rename', value: 'notes.md', selectStem: true, validate: (v) => (v ? null : 'Empty') });
    const input = document.querySelector<HTMLInputElement>('.text-input')!;
    expect([input.selectionStart, input.selectionEnd]).toEqual([0, 5]); // stem selected
    expect(buttons().map((b) => b.textContent)).toEqual(['Cancel', 'OK']);
    input.value = '  ';
    document.querySelector('form')!.dispatchEvent(new Event('submit', { cancelable: true }));
    expect(document.querySelector('.dialog-error')?.textContent).toBe('Empty');
    input.value = ' todo.md ';
    document.querySelector('form')!.dispatchEvent(new Event('submit', { cancelable: true }));
    expect(await p).toBe('todo.md');

    const q = promptDialog({ title: 'Name' });
    buttons()[0].click();
    expect(await q).toBeNull();
  });
});
