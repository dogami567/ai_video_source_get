import { expect, test } from "@playwright/test";

test("chat: resolve button updates card (proxy thumbnail + auto-resume after consent)", async ({ page, request }) => {
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
  await page.getByTestId("create-project-input").fill(`e2e-chat-resolve-${Date.now()}`);
  await page.getByTestId("create-project-btn").click();
  await expect(page.getByTestId("back-to-list")).toBeVisible();

  // Open Chat tab.
  await page.getByTestId("project-tab-chat").click();
  await expect(page.getByTestId("chat-panel")).toBeVisible();

  // Send a message containing a real Bilibili URL.
  // Chat should prompt for consent first, then auto-send after confirming.
  const bilibiliUrl =
    "https://www.bilibili.com/video/BV1CpzUBuEZ2/?spm_id_from=333.1387.homepage.video_card.click&vd_source=e75ce3ce84f093a660cd3e5dcd45eba23";
  const input = page.getByTestId("chat-input");
  await input.click();
  await input.type(bilibiliUrl);
  await input.press("Enter");

  await expect(page.getByTestId("consent-modal")).toBeVisible();
  await page.getByTestId("consent-confirm").click();
  await expect(page.getByTestId("consent-modal")).toHaveCount(0);

  await expect(page.getByTestId("chat-video-card")).toHaveCount(2);

  // Resolve should fetch metadata and use proxy thumbnails.
  await page.getByTestId("chat-video-resolve-0").click();

  await expect(page.getByTestId("chat-video-resolved-0")).toBeVisible({ timeout: 120_000 });

  const bg = await page.getByTestId("chat-video-thumb-0").evaluate((el) => getComputedStyle(el).backgroundImage);
  expect(bg).toContain("/api/proxy/image?");
});
