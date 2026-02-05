import { expect, test } from "@playwright/test";

test("chat: multi-asset prompt renders both videos + links (mock)", async ({ page, request }) => {
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
  await page.getByTestId("create-project-input").fill(`e2e-chat-multi-${Date.now()}`);
  await page.getByTestId("create-project-btn").click();
  await expect(page.getByTestId("back-to-list")).toBeVisible();

  // Open Chat tab.
  await page.getByTestId("project-tab-chat").click();
  await expect(page.getByTestId("chat-panel")).toBeVisible();

  const input = page.getByTestId("chat-input");
  await input.click();
  await input.type(
    "我要做b站up主“笔给你你来写”那种风格的视频，想要大概五分钟的画面素材，然后帮我找下他的ai配音（哈基米配音）一般是从哪弄的，比较简单和免费的，bgm也选哈基米好了。",
  );
  await input.press("Enter");

  await expect(page.getByText(/mock 模式/i)).toBeVisible({ timeout: 60_000 });
  await expect(page.getByTestId("chat-video-card")).toHaveCount(2);
  await expect(page.getByTestId("chat-link-card")).toHaveCount(2);
});

