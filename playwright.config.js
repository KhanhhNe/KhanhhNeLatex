import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: './tests/browser',
  timeout: 90000,
  fullyParallel: false,
  workers: 1,
  use: {
    baseURL: process.env.BASE_URL || 'http://127.0.0.1:8787',
    headless: true,
    viewport: { width: 1440, height: 1000 },
    screenshot: 'only-on-failure',
  },
  webServer: process.env.BASE_URL ? undefined : {
    command: 'npm run build && npm run preview',
    url: 'http://127.0.0.1:8787/api/health',
    reuseExistingServer: !process.env.CI,
    timeout: 60000,
  },
});
