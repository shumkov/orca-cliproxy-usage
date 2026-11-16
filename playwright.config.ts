import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: './tests/ui',
  fullyParallel: true,
  use: { baseURL: 'http://127.0.0.1:4179', headless: true, viewport: { width: 360, height: 640 } },
  webServer: { command: 'node scripts/serve-ui.mjs', url: 'http://127.0.0.1:4179', reuseExistingServer: false },
});
