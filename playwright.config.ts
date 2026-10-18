import { defineConfig, devices } from '@playwright/test';

const PORT = Number(process.env.E2E_PORT ?? 5182);
// PW_BROWSERS=chromium,webkit (default: chromium locally, both on CI).
const browsers = (process.env.PW_BROWSERS ?? (process.env.CI ? 'chromium,webkit' : 'chromium')).split(',');
const all = [
  { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
  { name: 'webkit', use: { ...devices['Desktop Safari'] } },
];

export default defineConfig({
  testDir: 'tests/e2e',
  timeout: 30_000,
  fullyParallel: true,
  // Containers often report the host's core count (nproc 64 under a 16-CPU quota).
  workers: process.env.PW_WORKERS ? Number(process.env.PW_WORKERS) : process.env.CI ? 6 : undefined,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['list'], ['json', { outputFile: process.env.PW_JSON ?? 'test-results/e2e.json' }]] : 'list',
  use: {
    baseURL: `http://localhost:${PORT}`,
    trace: 'retain-on-failure',
    // #152: entrance animations (dialog pop, context-menu drop) are transform
    // keyframes; under CI CPU starvation WebKit renders frames seconds apart, so a
    // "0.18s" pop stretches past the 30s budget and Playwright's stability check
    // never sees two identical frames. The app honors prefers-reduced-motion with
    // a global animation kill (styles.css), so boxes are static from frame one.
    reducedMotion: 'reduce',
  },
  projects: all.filter((p) => browsers.includes(p.name)),
  webServer: {
    command: `npx vite --port ${PORT} --strictPort`,
    url: `http://localhost:${PORT}`,
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
  },
});
