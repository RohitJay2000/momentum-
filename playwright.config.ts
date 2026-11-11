import { defineConfig, devices } from "@playwright/test";

// WebKit (Safari's engine, the same one the Mac app window uses) runs in CI on macOS.
const withWebkit = process.env.E2E_WEBKIT === "1";

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: false,
  retries: 0,
  reporter: [["list"]],
  use: {
    baseURL: "http://localhost:4173",
    trace: "retain-on-failure",
  },
  webServer: {
    command: "npm run build && npm run preview",
    url: "http://localhost:4173",
    reuseExistingServer: false,
    timeout: 120_000,
  },
  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"] } },
    ...(withWebkit ? [{ name: "webkit", use: { ...devices["Desktop Safari"] } }] : []),
  ],
});
