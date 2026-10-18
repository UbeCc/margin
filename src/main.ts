import { App } from './app/app';
import { loadWiring } from './app/wiring';
import { WEB_ROOT } from './platform';

declare global {
  interface Window {
    __margin?: App;
  }
}

async function boot(): Promise<void> {
  const mount = document.getElementById('app');
  if (!mount) throw new Error('#app missing');
  const wiring = await loadWiring();
  const app = new App(wiring, mount);
  window.__margin = app;
  // In the browser build, start in the sample folder (or ?folder=) unless files were passed via ?open=.
  const q = new URLSearchParams(location.search);
  // File › New Window (#94): an empty window (or one file via ?open=), no folder restore.
  const fresh = q.get('window') === 'new';
  let demo: { initialFolder: string | null; initialFile: string | null } | undefined;
  if (wiring.platform.kind === 'web' && !fresh) {
    const folder = q.get('folder') || WEB_ROOT;
    demo = { initialFolder: folder, initialFile: q.has('open') ? null : `${folder}/Welcome.md` };
  }
  // New Window keeps the opener's sidebar folder (?folder= on a window=new URL).
  if (fresh && q.get('folder')) demo = { initialFolder: q.get('folder'), initialFile: null };
  await app.start({ ...demo, fresh });
}

boot().catch((e) => {
  console.error(e);
  const pre = document.createElement('pre');
  pre.className = 'boot-error';
  pre.textContent = `Margin failed to start:\n${e instanceof Error ? e.stack ?? e.message : String(e)}`;
  document.body.appendChild(pre);
});
