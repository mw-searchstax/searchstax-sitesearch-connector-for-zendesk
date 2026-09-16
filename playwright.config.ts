import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/browser",
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? "github" : "list",
  use: {
    baseURL: `http://127.0.0.1:${process.env.BROWSER_TEST_PORT ?? "4173"}`,
    trace: "retain-on-failure",
  },
  webServer: {
    command:
      "npm run build && node --experimental-transform-types scripts/browser-test-host.ts",
    url: `http://127.0.0.1:${process.env.BROWSER_TEST_PORT ?? "4173"}`,
    reuseExistingServer: false,
  },
  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"] } },
    { name: "firefox", use: { ...devices["Desktop Firefox"] } },
    { name: "webkit", use: { ...devices["Desktop Safari"] } },
  ],
});
