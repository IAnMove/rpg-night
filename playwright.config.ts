import { defineConfig, devices } from '@playwright/test';
export default defineConfig({
  testDir: './tests/e2e', fullyParallel: false, timeout: 30000,
  use: { ...devices['Desktop Chrome'], baseURL: 'http://127.0.0.1:3101',
    channel: process.env.PLAYWRIGHT_CHANNEL || undefined, trace: 'retain-on-failure' },
  webServer: { command: 'npm start', url: 'http://127.0.0.1:3101/api/health', reuseExistingServer: false,
    env: { PORT: '3101', HOST: '127.0.0.1', RPG_MCP_URL: 'http://127.0.0.1:3101/mcp', HOST_MODE: 'ollama', PROVIDER: 'demo', DATA_DIR: './.work/browser-data', NODE_ENV: 'production' } },
});
