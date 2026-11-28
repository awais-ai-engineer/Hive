import { defineConfig } from '@playwright/test';

const port = process.env.PLAYWRIGHT_PORT || '3000';

export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  workers: 1,
  timeout: 90_000,
  expect: { timeout: 10_000 },
  outputDir: '../../output/playwright',
  use: { baseURL: `http://localhost:${port}`, channel: process.env.PLAYWRIGHT_CHANNEL || undefined, viewport: { width: 1280, height: 900 }, trace: 'retain-on-failure' },
  webServer: {
    command: `pnpm exec next dev --turbopack -p ${port}`,
    url: `http://localhost:${port}/login`,
    reuseExistingServer: !process.env.CI,
    timeout: 180_000,
    env: { NODE_OPTIONS: '--max-old-space-size=2048' },
  },
});
