import { App } from './app/app';
import { loadWiring } from './app/wiring';

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
  let demo: { initialFolder: string; initialFile: string } | undefined;
  if (wiring.using.platform === 'stub') {
    const { DEMO_ROOT } = await import('./app/dev-stubs');
    demo = { initialFolder: DEMO_ROOT, initialFile: `${DEMO_ROOT}/Welcome.md` };
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
