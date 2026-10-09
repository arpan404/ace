import { expect, test, type Locator, type Page } from "@playwright/test";
import { stageInformativeSidebar } from "./informative-sidebar.fixture.ts";

const shots = "/tmp/ace-orch/shots/ui-task-row-polish";
async function paintedProviders(scope: Locator | Page) {
  // Provider glyphs load lazily; their layout box is present before the artwork.
  await expect
    .poll(() =>
      scope
        .getByRole("img", { name: /^(Codex|Claude Code|OpenCode)/ })
        .evaluateAll((marks) =>
          marks.every((mark) => (mark.querySelector("svg")?.getBBox().width ?? 0) > 0),
        ),
    )
    .toBe(true);
}
const ink = (element: Locator) => element.evaluate((node) => getComputedStyle(node).color);
async function themeInk(page: Page, token: string) {
  return page.evaluate((name) => {
    const sample = document.createElement("span");
    sample.style.color = `var(--${name})`;
    document.body.append(sample);
    const colour = getComputedStyle(sample).color;
    sample.remove();
    return colour;
  }, token);
}
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
        row("Review the release plan").getByText("Approve", { exact: true }),
      ).toBeVisible();
      await expect(row("Choose a retry policy").getByText("Answer", { exact: true })).toBeVisible();
      await expect(
        row("Build replay recovery").getByText("Waiting", { exact: true }),
      ).toBeVisible();
      await expect(row("Build replay recovery").getByText("⑂ 2", { exact: true })).toBeVisible();
      await expect(
        row("Build replay recovery").getByRole("img", { name: "draft pull request #283" }),
      ).toBeVisible();
      await expect(row("Build replay recovery").getByText("+24", { exact: true })).toBeVisible();
      await expect(
        row("Publish the release").getByText("Build server", { exact: true }),
      ).toBeHidden();
      await expect(row("Retry workspace sync").getByText(/^Limited/)).toBeVisible();
      await expect(
        row("Fix a flaky browser test").getByText("Failed", { exact: true }),
      ).toBeVisible();
      const muted = await themeInk(page, "muted-foreground");
      const foreground = await themeInk(page, "foreground");
      for (const title of [
        "Build replay recovery",
        "Run the mobile checks",
        "Publish the release",
        "Retry workspace sync",
        "Tidy the README",
      ]) {
        expect(await ink(row(title).getByText(title, { exact: true }))).toBe(muted);
      }
      expect(await ink(row("Build replay recovery").getByText("Waiting", { exact: true }))).toBe(
        muted,
      );
      expect(await ink(row("Run the mobile checks").getByText("Working", { exact: true }))).toBe(
        muted,
      );
      expect(await ink(row("Retry workspace sync").getByText(/^Limited/))).toBe(muted);
      for (const title of [
        "Review the release plan",
        "Choose a retry policy",
        "Fix a flaky browser test",
      ])
        expect(await ink(row(title).getByText(title, { exact: true }))).toBe(foreground);
      expect(
        await ink(row("Review the release plan").getByText("Approve", { exact: true })),
      ).not.toBe(muted);
      expect(
        await ink(row("Fix a flaky browser test").getByText("Failed", { exact: true })),
      ).not.toBe(muted);
      await row("Write the install guide").click({ button: "right" });
      await page.getByRole("menuitem", { name: /^Mark unread/ }).click();
      await page.mouse.move(width - 2, 840);
      await expect(
        row("Write the install guide").getByRole("img", { name: "Unread activity" }),
      ).toBeVisible();
      expect(
        await ink(
          row("Write the install guide").getByText("Write the install guide", { exact: true }),
        ),
      ).toBe(foreground);
      await expect(nav.getByText("Workshop Mac", { exact: true })).toHaveCount(0);
      await expect(nav.getByText("New thread", { exact: true })).toHaveCount(0);
      await nav.getByRole("button", { name: /^Settled/ }).click();
      await expect(row("Bump the client SDK")).toBeVisible();
      await paintedProviders(nav);
      await nav.locator("[data-virtual-viewport]").evaluate((element) => element.scrollTo(0, 0));
      await page.mouse.move(width - 2, 840);
      await page.screenshot({ path: `${shots}/tasks-${theme}-${width}.png` });
      const remote = row("Publish the release");
      await remote.hover();
      await expect(remote.getByText("Build server", { exact: true })).toBeVisible();
      await expect(page.getByRole("tooltip")).toContainText("Running on Build server");
      await page.screenshot({ path: `${shots}/machine-hover-${theme}-${width}.png` });
      await page.mouse.move(width - 2, 840);
      await expect(remote.getByText("Build server", { exact: true })).toBeHidden();
      await remote.focus();
      await expect(remote.getByText("Build server", { exact: true })).toBeVisible();
      await row("Review the release plan").focus();
      await expect(remote.getByText("Build server", { exact: true })).toBeHidden();
      const work = row("Build replay recovery");
      await work.hover();
      await expect(nav.getByRole("button", { name: "Settle Build replay recovery" })).toBeVisible();
      await expect(work.getByText("Waiting", { exact: true })).toBeHidden();
      await expect(work.getByText("+24", { exact: true })).toBeVisible();
      await expect(
        page.getByRole("tooltip").filter({ hasText: "Build replay recovery" }),
      ).toContainText("Build replay recovery");
      await expect(
        page.getByRole("tooltip").filter({ hasText: "Build replay recovery" }),
      ).toContainText("Waiting on 2 subagents");
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
      ).toBe(true);

      // Open a quiet thread: only its selected title and working status regain contrast.
      await page.goto("/t/live-3");
      const chip = page.getByRole("button", { name: /^Model: Opus 5.5, Personal/ });
      await expect(chip).toBeVisible();
      if (width === 1440) {
        expect(
          await ink(
            row("Run the mobile checks").getByText("Run the mobile checks", { exact: true }),
          ),
        ).toBe(foreground);
        expect(
          await ink(row("Run the mobile checks").getByText("Working", { exact: true })),
        ).not.toBe(muted);
      }
      await expect(chip.getByRole("img", { name: "Personal account", exact: true })).toBeVisible();
      await paintedProviders(page);
      await page.screenshot({ path: `${shots}/composer-${theme}-${width}.png` });
      await chip.click();
      await page.getByRole("button", { name: /^Change model/ }).click();
      const rail = page.getByRole("tablist", { name: "Model sources" });
      const personal = rail.getByRole("tab", { name: "Claude Code · Personal", exact: true });
      const workAccount = rail.getByRole("tab", { name: "Claude Code · Work", exact: true });
      await expect(
        personal.getByRole("img", { name: "Personal account", exact: true }),
      ).toBeVisible();
      await expect(
        workAccount.getByRole("img", { name: "Work account", exact: true }),
      ).toBeVisible();
      await paintedProviders(rail);
      await workAccount.hover();
      await expect(page.getByRole("tooltip")).toContainText("Claude Code · Work");
      await page.screenshot({ path: `${shots}/picker-${theme}-${width}.png` });
    });

test("working elapsed time advances without streaming resetting it", async ({ page }) => {
  await page.clock.install();
  await stageInformativeSidebar(page, "dark");
  await page.goto("/new");
  const row = page
    .getByRole("navigation", { name: "Threads" })
    .getByRole("link", { name: /^Run the mobile checks/ });
  await expect(row.getByText("1m", { exact: true })).toBeVisible();
  await page.clock.fastForward(60_000);
  await expect(row.getByText("2m", { exact: true })).toBeVisible();
});

test("unread work brightens only the title, while statuses fit without clipping", async ({
  page,
}) => {
  await stageInformativeSidebar(page, "dark");
  await page.goto("/new");
  const nav = page.getByRole("navigation", { name: "Threads" });
  const work = nav.getByRole("link", { name: /^Run the mobile checks/ });
  await work.click({ button: "right" });
  await page.getByRole("menuitem", { name: /^Mark unread/ }).click();
  await page.mouse.move(1400, 840);
  await expect(work.getByRole("img", { name: "Unread activity" })).toBeVisible();
  expect(await ink(work.getByText("Run the mobile checks", { exact: true }))).toBe(
    await themeInk(page, "foreground"),
  );
  expect(await ink(work.getByText("Working", { exact: true }))).toBe(
    await themeInk(page, "muted-foreground"),
  );
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 900 });
    if (width === 390) await page.getByRole("button", { name: "Back to threads" }).click();
    await page.getByRole("heading", { name: "Threads", exact: true }).click();
    await page.mouse.move(width - 2, 2);
    for (const words of ["Approve", "Answer", "Waiting", "Working", "Failed"]) {
      const status = nav.getByText(words, { exact: true }).first();
      await expect(status).toBeVisible();
      // The rendered text must fit its own box, rather than hiding behind an ellipsis.
      expect(
        await status.evaluate((element) => {
          const range = document.createRange();
          range.selectNodeContents(element);
          return range.getBoundingClientRect().width <= element.getBoundingClientRect().width + 0.5;
        }),
      ).toBe(true);
    }
  }
});
