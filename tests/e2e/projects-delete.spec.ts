import { expect, test } from "@playwright/test";

test("projects: batch delete selected", async ({ page, request }) => {
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

  const title1 = `e2e-del-a-${Date.now()}`;
  const title2 = `e2e-del-b-${Date.now()}`;

  // Create project A.
  await page.getByTestId("create-project-input").fill(title1);
  await page.getByTestId("create-project-btn").click();
  await expect(page.getByTestId("back-to-list")).toBeVisible();
  await page.getByTestId("back-to-list").click();

  // Create project B.
  await page.getByTestId("create-project-input").fill(title2);
  await page.getByTestId("create-project-btn").click();
  await expect(page.getByTestId("back-to-list")).toBeVisible();
  await page.getByTestId("back-to-list").click();

  // Select both projects.
  await page.locator("tr", { hasText: title1 }).locator('input[data-testid^="select-project-"]').click();
  await page.locator("tr", { hasText: title2 }).locator('input[data-testid^="select-project-"]').click();

  // Batch delete selected.
  page.once("dialog", (d) => d.accept());
  await page.getByTestId("delete-selected-projects").click();

  await expect(page.getByText(title1)).toHaveCount(0);
  await expect(page.getByText(title2)).toHaveCount(0);
});

