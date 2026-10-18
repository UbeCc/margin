import type { EditorHandle } from '../../contracts';
import { h } from '../util/dom';
import { openModal } from '../ui/modal';

/** What Take Picture needs from the shell. */
export interface TakePictureHost {
  editor(): EditorHandle;
  /** The shell's image insertion pipeline (ImageFeature.store): returns the snippet. */
  store(input: { bytes: Uint8Array; mime?: string; name?: string }): Promise<string | null>;
  notify(message: string, kind: 'info' | 'error' | 'success'): void;
}

/**
 * Format › Take Picture (#136): live camera preview (getUserMedia); the captured
 * frame becomes a PNG that goes through the normal image insertion rules
 * (copy to folder / upload / keep). Typora's nib ships the menu entry without a
 * documented action (typora-re question); capture-and-insert is Margin's choice.
 * Resolves true when a picture was taken and inserted.
 */
export async function takePicture(host: TakePictureHost): Promise<boolean> {
  let stream: MediaStream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ video: { width: { ideal: 1280 } }, audio: false });
  } catch (e) {
    host.notify(`Camera unavailable: ${e instanceof Error ? e.message : String(e)}`, 'error');
    return false;
  }
  // eslint-disable-next-line no-promise-executor-return -- resolve handed to the dialog (target lib predates Promise.withResolvers)
  return new Promise<boolean>((resolve) => {
    const video = h('video.take-picture-video', { autoplay: '', playsinline: '', muted: '', 'aria-label': 'Camera preview' }) as HTMLVideoElement;
    video.srcObject = stream;
    try {
      void video.play()?.catch(() => undefined); // jsdom: play() is not implemented
    } catch {
      /* preview stays on the first frame */
    }
    let done = false;
    const finish = (ok: boolean): void => {
      if (done) return;
      done = true;
      for (const t of stream.getTracks()) t.stop();
      modal.close();
      resolve(ok);
    };
    const shoot = (): void => {
      const c = document.createElement('canvas');
      c.width = video.videoWidth || 640;
      c.height = video.videoHeight || 480;
      const ctx = c.getContext('2d');
      // jsdom / headless without canvas: surface the failure instead of crashing.
      if (!ctx || typeof c.toBlob !== 'function') {
        host.notify('Could not capture a picture.', 'error');
        finish(false);
        return;
      }
      ctx.drawImage(video, 0, 0, c.width, c.height);
      c.toBlob(
        (blob) =>
          void (async () => {
            if (!blob) {
              host.notify('Could not capture a picture.', 'error');
              finish(false);
              return;
            }
            const bytes = new Uint8Array(await blob.arrayBuffer());
            const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
            const snippet = await host.store({ bytes, mime: 'image/png', name: `picture-${stamp}.png` }).catch(() => null);
            if (!snippet) {
              finish(false);
              return;
            }
            const ed = host.editor();
            ed.focus();
            // x/y 0,0 misses every element → falls back to the caret / selection.
            ed.exec({ kind: 'insertMarkdownAt', markdown: snippet, x: 0, y: 0 });
            finish(true);
          })(),
        'image/png',
      );
    };
    const form = h(
      'div.dialog.take-picture',
      null,
      h('h2.dialog-title', { text: 'Take Picture' }),
      video,
      h(
        'div.dialog-buttons',
        null,
        h('button.btn', { type: 'button', text: 'Cancel', onclick: () => finish(false) }),
        h('button.btn.btn-primary', { type: 'button', text: 'Take Picture', onclick: shoot }),
      ),
    );
    const modal = openModal(form, { className: 'dialog-card', onDismiss: () => finish(false), label: 'Take Picture' });
    void modal;
  });
}
