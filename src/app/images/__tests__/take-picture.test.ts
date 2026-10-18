import { afterEach, describe, expect, it, vi } from 'vitest';
import { takePicture } from '../take-picture';
import { fakeEditor } from '../../__tests__/upload-fakes';

const notes: [string, string][] = [];

afterEach(() => {
  document.body.replaceChildren();
  vi.restoreAllMocks();
  notes.length = 0;
});

/** MediaStream double whose tracks record stop() calls. */
function fakeStream(): { stream: MediaStream; stopped: () => number } {
  let stopped = 0;
  const track = { stop: (): void => { stopped += 1; } };
  const stream = { getTracks: () => [track, track] } as unknown as MediaStream;
  return { stream, stopped: () => stopped };
}

function stubCamera(fn: () => Promise<MediaStream>): void {
  Object.defineProperty(navigator, 'mediaDevices', { value: { getUserMedia: fn }, configurable: true });
}

function makeHost(snippet: string | null = '![picture-20260101000000](assets/picture-20260101000000.png)') {
  return {
    editor: fakeEditor(''),
    store: vi.fn().mockResolvedValue(snippet),
    notify: (m: string, k: string): void => {
      notes.push([m, k]);
    },
  };
}

describe('takePicture (#136)', () => {
  it('reports when no camera is available', async () => {
    stubCamera(vi.fn().mockRejectedValue(new Error('permission denied')));
    await expect(takePicture(makeHost())).resolves.toBe(false);
    expect(notes).toEqual([['Camera unavailable: permission denied', 'error']]);
    expect(document.querySelector('.take-picture')).toBeNull();
  });

  it('shows the preview; Cancel closes the dialog and stops the tracks', async () => {
    const { stream, stopped } = fakeStream();
    stubCamera(vi.fn().mockResolvedValue(stream));
    const p = takePicture(makeHost());
    const dlg = await (async (): Promise<HTMLElement> => {
      await vi.waitFor(() => expect(document.querySelector('.take-picture')).toBeTruthy());
      return document.querySelector<HTMLElement>('.take-picture')!;
    })();
    expect(dlg.querySelector('.take-picture-video')).toBeTruthy();
    (dlg.querySelector('.dialog-buttons .btn') as HTMLElement).click(); // Cancel
    await expect(p).resolves.toBe(false);
    expect(document.querySelector('.take-picture')).toBeNull();
    expect(stopped()).toBe(2);
    expect(notes).toEqual([]);
  });

  it('captures a frame, stores it through the image rules and inserts the snippet', async () => {
    const { stream, stopped } = fakeStream();
    stubCamera(vi.fn().mockResolvedValue(stream));
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({ drawImage: vi.fn() } as unknown as CanvasRenderingContext2D);
    vi.spyOn(HTMLCanvasElement.prototype, 'toBlob').mockImplementation(function (this: HTMLCanvasElement, cb: BlobCallback) {
      cb(new Blob(['png'], { type: 'image/png' }));
    });
    const editor = fakeEditor('');
    const exec = vi.spyOn(editor, 'exec');
    const store = vi.fn().mockResolvedValue('![alt](assets/picture-x.png)');
    const host = { editor: () => editor, store, notify: (m: string, k: string) => notes.push([m, k]) };
    const p = takePicture(host);
    await vi.waitFor(() => expect(document.querySelector('.take-picture')).toBeTruthy());
    (document.querySelector('.take-picture .btn-primary') as HTMLElement).click(); // Take Picture
    await expect(p).resolves.toBe(true);
    expect(store).toHaveBeenCalledTimes(1);
    const input = store.mock.calls[0][0] as { mime: string; name: string };
    expect(input.mime).toBe('image/png');
    expect(input.name).toMatch(/^picture-\d{14}\.png$/);
    expect(exec).toHaveBeenCalledWith({ kind: 'insertMarkdownAt', markdown: '![alt](assets/picture-x.png)', x: 0, y: 0 });
    expect(stopped()).toBe(2);
    expect(document.querySelector('.take-picture')).toBeNull();
  });

  it('surfaces capture failure when canvas is unavailable (headless)', async () => {
    const { stream } = fakeStream();
    stubCamera(vi.fn().mockResolvedValue(stream));
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
    const p = takePicture(makeHost());
    await vi.waitFor(() => expect(document.querySelector('.take-picture')).toBeTruthy());
    (document.querySelector('.take-picture .btn-primary') as HTMLElement).click();
    await expect(p).resolves.toBe(false);
    expect(notes).toEqual([['Could not capture a picture.', 'error']]);
  });
});
