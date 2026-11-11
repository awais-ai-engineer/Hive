import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  workers: 1,
  timeout: 90_000,
  expect: { timeout: 10_000 },
  outputDir: '../../output/playwright',
  use: { baseURL: 'http://localhost:3000', channel: process.env.PLAYWRIGHT_CHANNEL || undefined, viewport: { width: 1280, height: 900 }, trace: 'retain-on-failure' },
  webServer: {
    command: 'pnpm exec next dev --turbopack -p 3000',
    url: 'http://localhost:3000/login',
    reuseExistingServer: !process.env.CI,
    timeout: 180_000,
    env: { NODE_OPTIONS: '--max-old-space-size=2048' },
  },
});
