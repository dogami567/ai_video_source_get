import { expect, test } from "@playwright/test";

async function waitForOk(request: any, path: string) {
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
    await new Promise((r) => setTimeout(r, 1000));
  }
}

test("projects: delete single and batch delete", async ({ page, request }) => {
  await page.goto("/");
  await waitForOk(request, "/api/health");
  await waitForOk(request, "/tool/health");

  await expect(page.getByTestId("backend-offline")).toHaveCount(0);

  const title1 = `e2e-delete-one-${Date.now()}`;
  await page.getByTestId("create-project-input").fill(title1);
  await page.getByTestId("create-project-btn").click();
  await expect(page.getByTestId("back-to-list")).toBeVisible();
  await page.getByTestId("back-to-list").click();

  const list1 = await request.get("/tool/projects");
  const projects1 = (await list1.json()) as Array<{ id: string; title: string }>;
  const p1 = projects1.find((p) => p.title === title1);
  expect(p1, "created project should be listed").toBeTruthy();

  page.once("dialog", (d) => d.accept());
  await page.getByTestId(`delete-project-${p1!.id}`).click();
  await expect(page.getByText(title1)).toHaveCount(0);

  const title2 = `e2e-delete-batch-a-${Date.now()}`;
  const title3 = `e2e-delete-batch-b-${Date.now()}`;
  for (const t of [title2, title3]) {
    await page.getByTestId("create-project-input").fill(t);
    await page.getByTestId("create-project-btn").click();
    await expect(page.getByTestId("back-to-list")).toBeVisible();
    await page.getByTestId("back-to-list").click();
  }

  const list2 = await request.get("/tool/projects");
  const projects2 = (await list2.json()) as Array<{ id: string; title: string }>;
  const p2 = projects2.find((p) => p.title === title2);
  const p3 = projects2.find((p) => p.title === title3);
  expect(p2, "project A should be listed").toBeTruthy();
  expect(p3, "project B should be listed").toBeTruthy();

  await page.getByTestId(`select-project-${p2!.id}`).check();
  await page.getByTestId(`select-project-${p3!.id}`).check();

  page.once("dialog", (d) => d.accept());
  await page.getByTestId("delete-selected-projects").click();

  await expect(page.getByText(title2)).toHaveCount(0);
  await expect(page.getByText(title3)).toHaveCount(0);
});

