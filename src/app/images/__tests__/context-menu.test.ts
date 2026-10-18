import { afterEach, describe, expect, it, vi } from 'vitest';
import { copyImageContent } from '../context-menu';

afterEach(() => {
  vi.restoreAllMocks();
});

const img = (): HTMLImageElement => {
  const i = document.createElement('img');
  i.src = 'asset://host/dir/a.png';
  return i;
};

describe('copyImageContent (#136: native write first, web fallback)', () => {
  it('writes the local file natively (PNG+TIFF) and never fetches', async () => {
    const native = vi.fn().mockResolvedValue(true);
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    await expect(copyImageContent(img(), '/abs/dir/a.png', native)).resolves.toBe(true);
    expect(native).toHaveBeenCalledTimes(1);
    expect(native).toHaveBeenCalledWith('/abs/dir/a.png');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('falls back to fetch + ClipboardItem when the native write declines', async () => {
    const native = vi.fn().mockResolvedValue(false);
    const blob = new Blob(['x'], { type: 'image/png' });
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue({ blob: async () => blob } as unknown as Response);
    const write = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { write }, configurable: true });
    vi.stubGlobal(
      'ClipboardItem',
      class {
        #items: Record<string, Blob>;
        constructor(items: Record<string, Blob>) {
          this.#items = items;
        }
        getType(t: string): Blob {
          return this.#items[t];
        }
      },
    );
    await expect(copyImageContent(img(), '/abs/dir/a.png', native)).resolves.toBe(true);
    expect(fetchSpy).toHaveBeenCalledWith('asset://host/dir/a.png');
    expect(write).toHaveBeenCalledTimes(1);
    const [items] = write.mock.calls[0] as unknown as [[{ getType(t: string): Blob }]];
    expect(items[0].getType('image/png')).toBeTruthy();
  });

  it('returns false when both paths fail', async () => {
    const native = vi.fn().mockResolvedValue(false);
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('asset url blocked'));
    await expect(copyImageContent(img(), '/abs/dir/a.png', native)).resolves.toBe(false);
    await expect(copyImageContent(img())).resolves.toBe(false);
  });
});
