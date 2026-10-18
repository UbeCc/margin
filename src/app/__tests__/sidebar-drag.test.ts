import { describe, expect, it, vi } from 'vitest';
import { makeDraggable } from '../sidebar/drag';

/** jsdom has no PointerEvent; MouseEvent carries everything we read. */
const ptr = (type: string, x: number, y: number, button = 0): PointerEvent =>
  new MouseEvent(type, { clientX: x, clientY: y, button, bubbles: true }) as unknown as PointerEvent;

function row(): HTMLElement {
  const r = document.createElement('div');
  r.draggable = true;
  document.body.appendChild(r);
  return r;
}

describe('sidebar native drag-out gesture (#129)', () => {
  it('starts a native drag once the press moves past the threshold and suppresses the HTML5 drag', () => {
    const r = row();
    const startFileDrag = vi.fn();
    makeDraggable(r, '/r/a.md', { startFileDrag });
    r.dispatchEvent(ptr('pointerdown', 10, 10));
    r.dispatchEvent(ptr('pointermove', 11, 11)); // below threshold
    expect(startFileDrag).not.toHaveBeenCalled();
    r.dispatchEvent(ptr('pointermove', 30, 12)); // past threshold
    expect(startFileDrag).toHaveBeenCalledTimes(1);
    expect(startFileDrag).toHaveBeenCalledWith(['/r/a.md']);
    expect(r.draggable).toBe(false); // HTML5 dragstart suppressed
    r.dispatchEvent(new Event('dragend'));
    expect(r.draggable).toBe(true); // restored for the next gesture
  });

  it('ignores non-left presses and detaches listeners on plain pointerup', () => {
    const r = row();
    const startFileDrag = vi.fn();
    makeDraggable(r, '/r/a.md', { startFileDrag });
    r.dispatchEvent(ptr('pointerdown', 10, 10, 2)); // right button
    r.dispatchEvent(ptr('pointermove', 40, 10));
    expect(startFileDrag).not.toHaveBeenCalled();
    const r2 = row();
    makeDraggable(r2, '/r/b.md', { startFileDrag });
    r2.dispatchEvent(ptr('pointerdown', 0, 0));
    r2.dispatchEvent(ptr('pointerup', 0, 0));
    r2.dispatchEvent(ptr('pointermove', 50, 0)); // gesture already over
    expect(startFileDrag).not.toHaveBeenCalled();
  });

  it('without a native platform hook the HTML5 drag is untouched', () => {
    const r = row();
    makeDraggable(r, '/r/c.md'); // browser: no startFileDrag
    r.dispatchEvent(ptr('pointerdown', 10, 10));
    r.dispatchEvent(ptr('pointermove', 60, 10));
    const store: Record<string, string> = {};
    const dt = { setData: (t: string, v: string) => (store[t] = v), getData: (t: string) => store[t] ?? '' } as unknown as DataTransfer;
    const ev = new MouseEvent('dragstart', { bubbles: true });
    Object.defineProperty(ev, 'dataTransfer', { value: dt });
    r.dispatchEvent(ev);
    expect(dt.getData('application/x-margin-path')).toBe('/r/c.md');
  });
});
