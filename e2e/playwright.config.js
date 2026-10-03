import { defineConfig, devices } from '@playwright/test'

/**
 * Expects a backend and a frontend that are already running (CI starts them; locally
 * point these at your dev servers):
 *
 *   E2E_BASE_URL  the web app            default http://127.0.0.1:5173
 *   E2E_API_URL   the backend API root   default http://127.0.0.1:5000/api/v1
 *
 * Run `MONGO_URI=<the backend's db> npm run seed` first. The suite
 * logs in with OTP 1234, so the backend needs USE_DEFAULT_OTP=true.
 */
export default defineConfig({
  testDir: './tests',
  globalSetup: './global-setup.js',
  timeout: 60_000,
  expect: { timeout: 15_000 },
  // One worker: the specs share one seeded database and a couple of them place
  // orders, so running them side by side would make the assertions order-dependent.
  workers: 1,
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }], ['github']] : [['list']],
  use: {
    baseURL: process.env.E2E_BASE_URL || 'http://127.0.0.1:5173',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'off',
    viewport: { width: 1280, height: 800 },
    // The rider app is useless without a position; give every page one.
    geolocation: { latitude: 17.386, longitude: 78.4875 },
    permissions: ['geolocation'],
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
})
