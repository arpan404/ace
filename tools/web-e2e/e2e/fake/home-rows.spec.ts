import { expect, test } from "@playwright/test";
import { stageSidebarTasks } from "./sidebar-tasks.fixture.ts";

/*
 * A Home row's marks give way to Settle or Unsettle on hover and focus. What they mean must stay
 * in the row's accessible name (with the page's real styles applied) and in its tooltip.
 */
test("a focused or hovered row keeps saying its status, and its tooltip what the marks mean", async ({
  page,
}) => {
  await page.goto("/t/thread-dedupe");
  const threads = page.getByRole("navigation", { name: "Threads" });
  const row = threads.getByRole("link", { name: /^Partial refunds double-count tax/ });
  await row.focus();
  await expect(row).toHaveAccessibleName(/Waiting for your approval.*Pull request #77/);
  await expect(page.getByRole("tooltip")).toContainText("Pull request #77");

  await page.getByRole("combobox", { name: "Message" }).focus();
  await row.hover();
  await expect(row).toHaveAccessibleName(/Waiting for your approval.*Pull request #77/);
  await expect(page.getByRole("tooltip")).toContainText("Waiting for your approval");
});

test("active tasks show their branch, changes and provider on a second line without hovering", async ({
  page,
}) => {
  await stageSidebarTasks(page);
  await page.goto("/new");
  const nav = page.getByRole("navigation", { name: "Threads" });
  const row = nav.getByRole("link", { name: /^Audit Console/ });
  const branch = row.getByText("console/consistency", { exact: true });
  await expect(branch).toBeVisible();
  await expect(row.getByText("+3", { exact: true })).toBeVisible();
  await expect(row.getByText("−1", { exact: true })).toBeVisible();
  await expect(row.getByRole("img", { name: "Claude Code" })).toBeVisible();
  const taskTitle = row.getByText("Audit Console Feature Gaps", { exact: true });
  expect((await branch.boundingBox())?.y).toBeGreaterThan((await taskTitle.boundingBox())?.y ?? 0);
  expect((await row.boundingBox())?.height).toBeGreaterThanOrEqual(32);
  expect((await row.boundingBox())?.height).toBeLessThanOrEqual(36);
  await expect(nav.getByText("Recent", { exact: true })).toHaveCount(0);
  await expect(nav.getByRole("link", { name: /^New thread/ })).toHaveCount(0);
  for (const title of ["yo!", "greeting", "Hi bro"]) {
    const task = nav.getByRole("link", { name: new RegExp(`^${title}`) });
    await expect(task.getByText(title, { exact: true })).toBeVisible();
    await expect(task.getByText("OpenForge", { exact: true })).toBeVisible();
    if (title === "Hi bro")
      await expect(task.getByText("Build server", { exact: true })).toBeVisible();
    await expect(
      task.getByRole("img", { name: title === "greeting" ? "Claude Code" : "Codex" }),
    ).toBeVisible();
  }
  await nav.getByRole("button", { name: "Settled 1" }).click();
  const settled = nav.getByRole("link", { name: /^Build Agent State Engine/ });
  await expect(settled.getByText("OF", { exact: true })).toBeVisible();
  await expect(settled.getByText("feat/agent-state", { exact: true })).toHaveCount(0);
  expect((await settled.boundingBox())?.height).toBeLessThanOrEqual(36);
  await row.hover();
  await expect(row.getByText("Working", { exact: true })).toBeHidden();
  await expect(row.getByText("+3", { exact: true })).toBeVisible();
  await expect(
    nav.getByRole("button", { name: "Settle Audit Console Feature Gaps" }),
  ).toBeVisible();
  await expect(nav.getByRole("button", { name: /^Pin |^Snooze / })).toHaveCount(0);
});

test("mouse selection fills a task and keyboard focus adds a subtle ring", async ({ page }) => {
  await stageSidebarTasks(page);
  await page.goto("/new");
  const row = page.getByRole("navigation", { name: "Threads" }).getByRole("link", { name: /^yo!/ });
  const paint = () =>
    row.evaluate((element) => {
      const style = getComputedStyle(element);
      return {
        background: style.backgroundColor,
        shadow: style.boxShadow,
        outline: style.outlineStyle,
      };
    });
  const before = await paint();
  await row.click();
  await expect(row).toHaveAttribute("aria-current", "page");
  await expect.poll(async () => (await paint()).background).not.toBe(before.background);
  expect((await paint()).shadow).toBe("none");
  expect((await paint()).outline).toBe("none");
  await page.keyboard.press("Tab");
  await row.focus();
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("ArrowUp");
  await expect.poll(async () => (await paint()).shadow).not.toBe("none");
});

for (const theme of ["light", "dark"])
  for (const width of [1440, 390])
    test(`task sidebar in ${theme} at ${width}`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
      await stageSidebarTasks(page, theme);
      await page.goto("/t/sidebar-3");
      if (width === 390) await page.getByRole("button", { name: "Back to threads" }).click();
      const nav = page.getByRole("navigation", { name: "Threads" });
      await expect(nav.getByRole("link", { name: /^Audit Console/ })).toBeVisible();
      await nav.getByRole("button", { name: "Settled 1" }).click();
      await expect(nav.getByRole("link", { name: /^Build Agent/ })).toBeVisible();
      await page.mouse.move(width - 2, 898);
      await page.screenshot({
        animations: "disabled",
        path: `/tmp/ace-orch/shots/fix-sidebar-task-rows/sidebar-${theme}-${width}.png`,
      });
    });

test("long task titles truncate and the tooltip shows the full title", async ({ page }) => {
  await stageSidebarTasks(page);
  await page.goto("/new");
  const fullTitle = "independent browser-path check with a deliberately long task title";
  const row = page
    .getByRole("navigation", { name: "Threads" })
    .getByRole("link", { name: new RegExp(`^${fullTitle}`) });
  const title = row.getByText(fullTitle, { exact: true });
  expect(
    await title.evaluate(
      (element) =>
        element.scrollWidth > element.clientWidth &&
        getComputedStyle(element).textOverflow === "ellipsis",
    ),
  ).toBe(true);
  await row.hover();
  await expect(page.getByRole("tooltip")).toContainText(fullTitle);
});

for (const theme of ["midnight", "graphite", "paper", "slate", "contrast"])
  test(`task context fits the ${theme} preset on a phone`, async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 900 });
    await stageSidebarTasks(page, theme);
    await page.goto("/t/sidebar-3");
    await page.getByRole("button", { name: "Back to threads" }).click();
    const nav = page.getByRole("navigation", { name: "Threads" });
    await expect(nav.getByText("console/consistency", { exact: true })).toBeVisible();
    expect(await nav.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
    await page.mouse.move(389, 898);
    await page.screenshot({
      animations: "disabled",
      path: `/tmp/ace-orch/shots/fix-sidebar-task-rows/sidebar-${theme}-390.png`,
    });
  });
