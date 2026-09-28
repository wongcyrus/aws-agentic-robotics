import { defineConfig, devices } from '@playwright/test';

const awsMode = process.env.E2E_MODE === 'aws';
const baseURL = awsMode
  ? process.env.PLAYWRIGHT_BASE_URL
  : process.env.PLAYWRIGHT_BASE_URL ?? 'http://127.0.0.1:4173';

if (!baseURL) {
  throw new Error('PLAYWRIGHT_BASE_URL is required when E2E_MODE=aws');
}
if (awsMode && !process.env.PLAYWRIGHT_WS_URL) {
  throw new Error('PLAYWRIGHT_WS_URL is required when E2E_MODE=aws');
}
if (awsMode && !process.env.PLAYWRIGHT_COGNITO_ID_TOKEN) {
  throw new Error('PLAYWRIGHT_COGNITO_ID_TOKEN is required when E2E_MODE=aws');
}

export default defineConfig({
  testDir: './e2e',
  timeout: 90_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1,
  retries: awsMode || process.env.CI ? 1 : 0,
  reporter: [['list'], ['html', { outputFolder: 'playwright-report', open: 'never' }]],
  outputDir: 'test-results',
  use: {
    baseURL,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure'
  },
  webServer: awsMode ? undefined : {
    command: 'E2E_TEST_MODE=1 PORT=4173 npm run dev',
    url: 'http://127.0.0.1:4173',
    reuseExistingServer: false,
    timeout: 120_000
  },
  projects: [{
    name: 'chromium',
    use: { ...devices['Desktop Chrome'] }
  }]
});
