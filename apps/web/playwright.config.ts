import { defineConfig, devices } from "@playwright/test";

const baseURL = "http://127.0.0.1:3010";

export default defineConfig({
  testDir: "./e2e",
  timeout: 90_000,
  expect: { timeout: 20_000 },
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: "list",
  use: {
    baseURL,
    trace: "retain-on-failure",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    command: "node ../api/scripts/e2e-stack.cjs",
    url: baseURL,
    timeout: 180_000,
    reuseExistingServer: false,
    env: {
      E2E_WEB_PORT: "3010",
      E2E_API_PORT: "4010",
    },
  },
});
