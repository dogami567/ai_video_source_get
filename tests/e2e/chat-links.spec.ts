import { expect, test } from "@playwright/test";

test("chat: links block renders for website info requests (mock)", async ({ page, request }) => {
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
  await page.getByTestId("create-project-input").fill(`e2e-chat-links-${Date.now()}`);
  await page.getByTestId("create-project-btn").click();
  await expect(page.getByTestId("back-to-list")).toBeVisible();

  // Open Chat tab.
  await page.getByTestId("project-tab-chat").click();
  await expect(page.getByTestId("chat-panel")).toBeVisible();

  // Send a message that clearly asks for websites/info (not videos).
  const input = page.getByTestId("chat-input");
  await input.click();
  await input.type("搜集一下吧，我主要想看看网站信息");
  await input.press("Enter");

  // In E2E mock mode, orchestrator returns a links block for this intent.
  await expect(page.getByText(/示例链接|mock 模式/i)).toBeVisible({ timeout: 60_000 });
  await expect(page.getByTestId("chat-link-card")).toHaveCount(2);
});

