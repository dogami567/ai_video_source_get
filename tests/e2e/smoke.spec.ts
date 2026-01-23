import { expect, test } from "@playwright/test";

test("smoke: non-API flows (settings, project, import, export)", async ({ page, request }) => {
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

  // Backend banner should not be shown once health endpoints are ok.
  await expect(page.getByTestId("backend-offline")).toHaveCount(0);

  // Global Settings (local-only, no API calls).
  await page.getByTestId("open-settings").click();
  await expect(page.getByTestId("settings-save")).toBeVisible();

  await page.getByTestId("settings-base-url").fill("https://example.invalid");
  await page.getByTestId("settings-gemini-key").fill("test-key");
  await page.getByTestId("settings-default-model").fill("gemini-3-preview");
  await page.getByTestId("settings-exa-key").fill("test-key");

  await page.getByTestId("settings-save").click();
  await expect(page.getByTestId("settings-saved")).toBeVisible();

  await page.getByTestId("settings-clear").click();
  await expect(page.getByTestId("settings-base-url")).toHaveValue("");
  await expect(page.getByTestId("settings-gemini-key")).toHaveValue("");
  await expect(page.getByTestId("settings-default-model")).toHaveValue("");
  await expect(page.getByTestId("settings-exa-key")).toHaveValue("");

  await page.getByTestId("settings-back").click();

  const createInput = page.getByTestId("create-project-input");
  await expect(createInput).toBeVisible();

  const placeholderBefore = await createInput.getAttribute("placeholder");
  await page.getByTestId("lang-toggle").click();
  const placeholderAfter = await createInput.getAttribute("placeholder");
  expect(placeholderAfter).not.toBe(placeholderBefore);

  await createInput.fill(`e2e-${Date.now()}`);
  await page.getByTestId("create-project-btn").click();
  await expect(page.getByTestId("back-to-list")).toBeVisible();

  // Import local "video" (no ffmpeg pipeline; just verifies upload path works).
  await page.getByTestId("local-file-input").setInputFiles("tests/fixtures/sample.mp4");
  await page.getByTestId("import-local").click();
  await expect(page.locator('div[title*=".mp4"]')).toBeVisible();

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

  // Project toggles (non-API).
  await expect(page.getByTestId("toggle-auto-confirm")).toBeEnabled();
  await page.getByTestId("toggle-auto-confirm-ui").click();
  await page.getByTestId("toggle-auto-confirm-ui").click();

  await page.getByTestId("toggle-think-ui").click();
  await page.getByTestId("toggle-think-ui").click();

  // Export helpers (non-API).
  await page.getByTestId("include-original-video").click();
  await page.getByTestId("include-original-video").click();

  await page.getByTestId("gen-report").click();
  await expect(page.getByText(/Report & Manifest generated|已生成报告与清单/i)).toBeVisible({ timeout: 60_000 });

  await page.getByTestId("estimate-zip").click();
  await expect(page.getByText(/Estimate:|预计：/i)).toBeVisible({ timeout: 60_000 });

  await page.getByTestId("export-zip").click();
  await expect(page.getByRole("link", { name: /download|下载/i })).toBeVisible({ timeout: 60_000 });

  // Back to project list should still work.
  await page.getByTestId("back-to-list").click();
  await expect(page.getByTestId("create-project-input")).toBeVisible();
});
