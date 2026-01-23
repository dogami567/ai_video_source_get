import { expect, test } from "@playwright/test";

test("smoke: create project, save url with consent, export zip", async ({ page, request }) => {
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

  const createInput = page.getByTestId("create-project-input");
  await expect(createInput).toBeVisible();

  const placeholderBefore = await createInput.getAttribute("placeholder");
  await page.getByTestId("lang-toggle").click();
  const placeholderAfter = await createInput.getAttribute("placeholder");
  expect(placeholderAfter).not.toBe(placeholderBefore);

  await createInput.fill(`e2e-${Date.now()}`);
  await page.getByTestId("create-project-btn").click();
  await expect(page.getByTestId("back-to-list")).toBeVisible();

  const url = "https://example.com/video";
  await page.getByTestId("input-url").fill(url);
  await page.getByTestId("save-url").click();

  const modal = page.getByTestId("consent-modal");
  try {
    await modal.waitFor({ state: "visible", timeout: 3000 });
    await page.getByTestId("consent-confirm").click();
    await modal.waitFor({ state: "hidden", timeout: 15_000 });
  } catch {
    // consent may already be granted; continue
  }

  await expect(page.locator(`div[title="${url}"]`)).toBeVisible();

  await page.getByTestId("export-zip").click();
  await expect(page.getByRole("link", { name: /download|下载/i })).toBeVisible({ timeout: 60_000 });
});
