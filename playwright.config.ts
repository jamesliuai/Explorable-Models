import { defineConfig, devices } from '@playwright/test';

/** Browser plugin is unavailable in this session; use the pinned Playwright Chromium. */
export default defineConfig({
  testDir: './tests/browser',
  fullyParallel: false,
  projects: process.env.EXPERIMENT_KIT_CROSS_BROWSER ? [
    { name: 'firefox', use: { ...devices['Desktop Firefox'] } },
    { name: 'webkit', use: { ...devices['Desktop Safari'] } },
  ] : [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  workers: 1,
  timeout: 35_000,
  expect: { timeout: 8_000 },
  retries: process.env.CI ? 1 : 0,
  reporter: [['list']],
  outputDir: '/tmp/experiment-kit-playwright',
  use: {
    ...devices['Desktop Chrome'],
    baseURL: 'http://127.0.0.1:4187',
    viewport: { width: 1440, height: 1000 },
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    reducedMotion: 'reduce',
  },
  webServer: {
    command: 'npm run dev -- --port 4187 --strictPort',
    url: 'http://127.0.0.1:4187',
    reuseExistingServer: false,
    timeout: 60_000,
    stdout: 'ignore',
    stderr: 'pipe',
  },
});
