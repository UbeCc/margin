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
  let demo: { initialFolder: string; initialFile: string | null } | undefined;
  if (wiring.platform.kind === 'web') {
    const q = new URLSearchParams(location.search);
    const folder = q.get('folder') || WEB_ROOT;
    demo = { initialFolder: folder, initialFile: q.has('open') ? null : `${folder}/Welcome.md` };
  }
  await app.start(demo);
}

boot().catch((e) => {
  console.error(e);
  const pre = document.createElement('pre');
  pre.className = 'boot-error';
  pre.textContent = `Margin failed to start:\n${e instanceof Error ? e.stack ?? e.message : String(e)}`;
  document.body.appendChild(pre);
});
