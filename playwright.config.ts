import { defineConfig, devices } from '@playwright/test';

const PORT = 5182;
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
  reporter: process.env.CI ? [['list'], ['json', { outputFile: process.env.PW_JSON ?? 'test-results/e2e.json' }]] : 'list',
  use: {
    baseURL: `http://localhost:${PORT}`,
    trace: 'retain-on-failure',
  },
  projects: all.filter((p) => browsers.includes(p.name)),
  webServer: {
    command: `npx vite --port ${PORT} --strictPort`,
    url: `http://localhost:${PORT}`,
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
  },
});
