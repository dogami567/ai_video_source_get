import { expect, test } from "@playwright/test";

test("chat: mock cards render and send behavior", async ({ page, request }) => {
  await page.goto("/");

  // Wait for backend services (orchestrator + toolserver) to be ready.
  const waitForOk = async (path: string) => {
    const startedAt = Date.now();
    let last: string | null = null;
    for (;;) {
      try {
        const res = await request.get(path);
        const status = res.status();
        const text = await res.text().catch(() => "");
        last = `${status} ${text.slice(0, 200)}`;
        if (status >= 200 && status < 300) {
          try {
            const json = JSON.parse(text) as unknown;
            if (typeof json === "object" && json !== null && (json as { ok?: unknown }).ok === true) return;
          } catch {
            // ignore
          }
        }
      } catch {
        // ignore
      }
      if (Date.now() - startedAt > 120_000) throw new Error(`timeout waiting for ${path} ok; last=${last ?? "n/a"}`);
      await page.waitForTimeout(1000);
    }
  };
  await waitForOk("/api/health");
  await waitForOk("/tool/health");

  await expect(page.getByTestId("backend-offline")).toHaveCount(0);

  // Create a project.
  await page.getByTestId("create-project-input").fill(`e2e-chat-${Date.now()}`);
  await page.getByTestId("create-project-btn").click();
  await expect(page.getByTestId("back-to-list")).toBeVisible();

  // Open Chat tab.
  await page.getByTestId("project-tab-chat").click();
  await expect(page.getByTestId("chat-panel")).toBeVisible();

  // Ensure there is at least one chat thread (auto-created).
  const threads = page.locator("button.chat-thread");
  await expect.poll(async () => await threads.count()).toBeGreaterThan(0);

  // New thread should increase count by 1.
  const beforeCount = await threads.count();
  await page.getByTestId("chat-new-thread").click();
  await expect.poll(async () => await threads.count()).toBe(beforeCount + 1);

  // Upload a file (verifies upload path + chip rendering).
  await page.getByTestId("chat-file-input").setInputFiles("tests/fixtures/sample.mp4");
  await expect(page.getByTestId("chat-attachments")).toContainText("sample.mp4");

  // Shift+Enter creates a newline; Enter sends.
  const input = page.getByTestId("chat-input");
  await input.click();
  await input.type("我想做视频剪辑，帮我找两个 B 站素材");
  await input.press("Shift+Enter");
  await input.type("要有封面、标题、描述");
  await input.press("Enter");

  // In E2E mock mode, assistant returns 2 video cards.
  await expect(page.getByText(/mock 模式/i)).toBeVisible({ timeout: 60_000 });
  await expect(page.getByTestId("chat-video-card")).toHaveCount(2);
});
