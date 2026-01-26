import { defineConfig, devices } from "@playwright/test";

const webPort = Number(process.env.E2E_WEB_PORT || process.env.WEB_PORT || 6785);
const orchestratorPort = Number(process.env.E2E_ORCHESTRATOR_PORT || process.env.ORCHESTRATOR_PORT || 6790);
const toolserverPort = Number(process.env.E2E_TOOLSERVER_PORT || process.env.TOOLSERVER_PORT || 6791);

const baseURL = process.env.E2E_BASE_URL || `http://127.0.0.1:${webPort}`;

export default defineConfig({
  testDir: "./tests/e2e",
  timeout: 180_000,
  expect: { timeout: 10_000 },
  retries: process.env.CI ? 1 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: [["list"], ["html", { open: "never" }]],
  use: {
    baseURL,
    trace: "on-first-retry",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
  },
  webServer: {
    command: "npm run dev",
    url: baseURL,
    timeout: 300_000,
    reuseExistingServer: false,
    env: {
      ...process.env,
      WEB_PORT: String(webPort),
      ORCHESTRATOR_PORT: String(orchestratorPort),
      TOOLSERVER_PORT: String(toolserverPort),
      DATA_DIR: process.env.E2E_DATA_DIR || process.env.DATA_DIR || "data/_e2e_dev",
    },
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
});

