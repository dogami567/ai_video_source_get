import { defineConfig, devices } from "@playwright/test";

const orchestratorPort = Number(process.env.E2E_ORCHESTRATOR_PORT || 17890);
const toolserverPort = Number(process.env.E2E_TOOLSERVER_PORT || 17891);
const baseURL = process.env.E2E_BASE_URL || `http://127.0.0.1:${orchestratorPort}`;

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
    command:
      'npm -w @vidunpack/web run build && npm -w @vidunpack/orchestrator run build && concurrently -n orchestrator,toolserver -c blue,magenta "npm -w @vidunpack/orchestrator run start" "node scripts/run-toolserver.mjs"',
    url: baseURL,
    timeout: 300_000,
    reuseExistingServer: false,
    env: {
      ...process.env,
      E2E_MOCK_CHAT: process.env.E2E_MOCK_CHAT || "1",
      ORCHESTRATOR_PORT: String(orchestratorPort),
      TOOLSERVER_PORT: String(toolserverPort),
      DATA_DIR: process.env.DATA_DIR || "data/_e2e",
    },
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
});
