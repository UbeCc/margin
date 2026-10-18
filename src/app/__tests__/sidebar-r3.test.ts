import { describe, expect, it, vi } from 'vitest';
import { ask } from '../ui/modal';
import { OutlineView } from '../sidebar/outline';

describe('ask() with suppression checkbox (#131)', () => {
  it('reports the checkbox state with the clicked button', async () => {
    const p = ask({
      title: 'Are you sure you want to move a.md?',
      buttons: [
        { id: 'cancel', label: 'Cancel' },
        { id: 'move', label: 'Move', primary: true },
      ],
      cancelId: 'cancel',
      checkbox: { label: 'Do not ask again' },
    });
    const box = document.querySelector('.dialog-checkbox input') as HTMLInputElement;
    expect(box).toBeTruthy();
    box.checked = true;
    box.dispatchEvent(new Event('change', { bubbles: true }));
    (document.querySelector('button[data-id=move]') as HTMLButtonElement).click();
    await expect(p).resolves.toEqual({ id: 'move', checked: true });
  });

  it('unchecked by default and Escape cancels without suppressing', async () => {
    const p = ask({
      title: 't',
      buttons: [
        { id: 'cancel', label: 'Cancel' },
        { id: 'move', label: 'Move', primary: true },
      ],
      cancelId: 'cancel',
      checkbox: { label: 'Do not ask again' },
    });
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await expect(p).resolves.toEqual({ id: 'cancel', checked: false });
  });
});

describe('outline pin/unpin (#131)', () => {
  it('unpin notifies with false and flips the button to Pin Outline', () => {
    const onPinned = vi.fn();
    const v = new OutlineView(() => undefined, { collapsible: false, pinned: true, onPinnedChange: onPinned });
    const btn = v.el.querySelector('.outline-pin') as HTMLButtonElement;
    expect(v.isPinned).toBe(true);
    expect(btn.title).toBe('Unpin Outline');
    btn.click();
    expect(onPinned).toHaveBeenCalledWith(false);
    expect(v.isPinned).toBe(false);
    expect(btn.title).toBe('Pin Outline');
    expect(v.el.dataset.pinned).toBe('false');
  });

  it('pin notifies with true and restores the button', () => {
    const onPinned = vi.fn();
    const v = new OutlineView(() => undefined, { collapsible: false, pinned: false, onPinnedChange: onPinned });
    const btn = v.el.querySelector('.outline-pin') as HTMLButtonElement;
    expect(v.el.dataset.pinned).toBe('false');
    btn.click();
    expect(onPinned).toHaveBeenCalledWith(true);
    expect(btn.title).toBe('Unpin Outline');
  });
});
