import { expect, test } from "@playwright/test";
import { stageInformativeSidebar } from "./informative-sidebar.fixture.ts";

const shots = "/tmp/ace-orch/shots/ui-task-rows-env-below";
for (const theme of ["light", "dark", "midnight", "graphite", "paper", "slate", "contrast"])
  for (const width of [1440, 390])
    test(`informative task rows in ${theme} at ${width}`, async ({ page }) => {
      await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
      await stageInformativeSidebar(page, theme);
      await page.goto("/new");
      await page.getByRole("heading", { name: "New thread", exact: true }).waitFor();
      if (width === 390) await page.getByRole("button", { name: "Back to threads" }).click();
      const nav = page.getByRole("navigation", { name: "Threads" });
      const row = (title: string) => nav.getByRole("link", { name: new RegExp(`^${title}`) });
      await expect(
        row("Review the release plan").getByText("Needs you", { exact: true }),
      ).toBeVisible();
      await expect(
        row("Choose a retry policy").getByText("Waiting for answer", { exact: true }),
      ).toBeVisible();
      await expect(
        row("Build replay recovery").getByText("Working", { exact: true }),
      ).toBeVisible();
      await expect(row("Build replay recovery").getByText("⑂ 2", { exact: true })).toBeVisible();
      await expect(
        row("Build replay recovery").getByRole("img", { name: "draft pull request #283" }),
      ).toBeVisible();
      await expect(row("Build replay recovery").getByText("+24", { exact: true })).toBeVisible();
      await expect(
        row("Publish the release").getByText("Build server", { exact: true }),
      ).toBeVisible();
      await expect(row("Retry workspace sync").getByText(/^Limited/)).toBeVisible();
      await expect(
        row("Fix a flaky browser test").getByText("Failed", { exact: true }),
      ).toBeVisible();
      await row("Write the install guide").click({ button: "right" });
      await page.getByRole("menuitem", { name: /^Mark unread/ }).click();
      await page.mouse.move(width - 2, 840);
      await expect(
        row("Write the install guide").getByRole("img", { name: "Unread activity" }),
      ).toBeVisible();
      await expect(nav.getByText("Workshop Mac", { exact: true })).toHaveCount(0);
      await expect(nav.getByText("New thread", { exact: true })).toHaveCount(0);
      await nav.getByRole("button", { name: /^Settled/ }).click();
      await expect(row("Bump the client SDK")).toBeVisible();
      await expect
        .poll(() =>
          nav
            .getByRole("img", { name: /^(Codex|Claude Code|OpenCode)/ })
            .evaluateAll((marks) =>
              marks.every((mark) => (mark.querySelector("svg")?.getBBox().width ?? 0) > 0),
            ),
        )
        .toBe(true);
      await nav.locator("[data-virtual-viewport]").evaluate((element) => element.scrollTo(0, 0));
      await page.mouse.move(width - 2, 840);
      await page.screenshot({ path: `${shots}/tasks-${theme}-${width}.png` });
      const work = row("Build replay recovery");
      await work.hover();
      await expect(nav.getByRole("button", { name: "Settle Build replay recovery" })).toBeVisible();
      await expect(work.getByText("Working", { exact: true })).toBeHidden();
      await expect(work.getByText("+24", { exact: true })).toBeVisible();
      await expect(page.getByRole("tooltip")).toContainText("Build replay recovery");
      await expect(page.getByRole("tooltip")).toContainText("Working");
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
      ).toBe(true);
    });

test("working elapsed time advances without streaming resetting it", async ({ page }) => {
  await page.clock.install();
  await stageInformativeSidebar(page, "dark");
  await page.goto("/new");
  const row = page
    .getByRole("navigation", { name: "Threads" })
    .getByRole("link", { name: /^Build replay recovery/ });
  await expect(row.getByText("· 1m", { exact: true })).toBeVisible();
  await page.clock.fastForward(60_000);
  await expect(row.getByText("· 2m", { exact: true })).toBeVisible();
});
