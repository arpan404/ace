import { expect, test } from "@playwright/test";
import { stageSidebarTasks } from "./sidebar-tasks.fixture.ts";

// Status and context stay visible beside the row's keyboard-accessible actions.
test("a focused or hovered row keeps saying its status, and its tooltip what the marks mean", async ({
  page,
}) => {
  await page.goto("/t/thread-dedupe");
  const threads = page.getByRole("navigation", { name: "Threads" });
  const row = threads.getByRole("link", { name: /^Partial refunds double-count tax/ });
  await row.focus();
  await expect(row).toHaveAccessibleName(/Waiting for your approval.*Pull request #77/);
  await expect(page.getByLabel(/^Details for Partial refunds double-count tax/)).toContainText(
    "77",
  );

  await page.getByRole("combobox", { name: "Message" }).focus();
  await row.hover();
  await expect(row).toHaveAccessibleName(/Waiting for your approval.*Pull request #77/);
  await expect(page.getByLabel(/^Details for Partial refunds double-count tax/)).toContainText(
    "Partial refunds double-count tax",
  );
});

test("tasks show project and status above the title, with branch and provider below", async ({
  page,
}) => {
  await stageSidebarTasks(page);
  await page.goto("/new");
  const nav = page.getByRole("navigation", { name: "Threads" });
  const row = nav.getByRole("link", { name: /^Audit Console/ });
  const branch = row.getByText("console/consistency", { exact: true });
  await expect(branch).toBeVisible();
  await expect(row.getByText("+3", { exact: true })).toHaveCount(0);
  await expect(row.getByText("−1", { exact: true })).toHaveCount(0);
  await expect(row.getByRole("img", { name: "Claude Code", exact: true })).toBeVisible();
  const taskTitle = row.getByText("Audit Console Feature Gaps", { exact: true });
  expect((await branch.boundingBox())?.y).toBeGreaterThan((await taskTitle.boundingBox())?.y ?? 0);
  expect((await row.boundingBox())?.height).toBeGreaterThanOrEqual(72);
  expect((await row.boundingBox())?.height).toBeLessThanOrEqual(88);
  const project = row.getByText("OpenForge", { exact: true });
  const status = row.getByText("Working", { exact: true });
  expect((await project.boundingBox())?.y).toBeLessThan((await taskTitle.boundingBox())?.y ?? 0);
  expect(
    Math.abs(((await status.boundingBox())?.y ?? 0) - ((await project.boundingBox())?.y ?? 0)),
  ).toBeLessThan(1);
  await expect(nav.getByText("Recent", { exact: true })).toHaveCount(0);
  await expect(nav.getByRole("link", { name: /^New thread/ })).toHaveCount(0);
  for (const title of ["yo!", "greeting", "Hi bro"]) {
    const task = nav.getByRole("link", { name: new RegExp(`^${title}`) });
    await expect(task.getByText(title, { exact: true })).toBeVisible();
    await expect(task.getByText("OpenForge", { exact: true })).toBeVisible();
    if (title === "Hi bro") {
      await expect(task).toHaveAccessibleName(/Running on Build server/);
      await task.hover();
      await expect(page.getByLabel("Details for Hi bro", { exact: true })).toContainText(
        "Build server",
      );
    }
    await expect(task).toHaveAccessibleName(title === "greeting" ? /Claude Code/ : /Codex/);
  }
  await nav.getByRole("button", { name: "Settled (1)" }).click();
  const settled = nav.getByRole("link", { name: /^Build Agent State Engine/ });
  await expect(settled.getByText("OpenForge", { exact: true })).toBeVisible();
  await expect(settled.getByText("feat/agent-state", { exact: true })).toBeVisible();
  expect((await settled.boundingBox())?.height).toBeGreaterThanOrEqual(80);
  await row.hover();
  await expect(row.getByText("Working", { exact: true })).toBeVisible();
  const provider = row.getByRole("img", { name: "Claude Code", exact: true });
  await expect(provider).toHaveCSS("opacity", "1");
  await row.focus();
  await expect(provider).toHaveCSS("opacity", "1");
  await expect(row.getByText("+3", { exact: true })).toHaveCount(0);
  const actions = nav.getByRole("button", { name: "Actions for Audit Console Feature Gaps" });
  await expect(actions).toBeVisible();
  await actions.click();
  await expect(page.getByRole("menuitem", { name: "Settle", exact: true })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(nav.getByRole("button", { name: /^Pin / })).toHaveCount(0);
});

test("opening a task selects it and arrow keys move to the next task", async ({ page }) => {
  await stageSidebarTasks(page);
  await page.goto("/new");
  const nav = page.getByRole("navigation", { name: "Threads" });
  const row = nav.getByRole("link", { name: /^yo!/ });
  await row.click();
  await expect(row).toHaveAttribute("aria-current", "page");
  await expect(page.getByRole("heading", { level: 1, name: "yo!", exact: true })).toBeVisible();
  await row.focus();
  await page.keyboard.press("ArrowDown");
  await expect(nav.getByRole("link", { name: /^greeting/ })).toBeFocused();
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
      await nav.getByRole("button", { name: "Settled (1)" }).click();
      await expect(nav.getByRole("link", { name: /^Build Agent/ })).toBeVisible();
      await page.mouse.move(width - 2, 898);
      await page.screenshot({
        animations: "disabled",
        path: `/tmp/ace-orch/shots/ui-task-rows-env-below/sidebar-${theme}-${width}.png`,
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
  await expect(page.getByLabel(`Details for ${fullTitle}`)).toContainText(fullTitle);
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
      path: `/tmp/ace-orch/shots/ui-task-rows-env-below/sidebar-${theme}-390.png`,
    });
  });

test("scrolling and focusing a task clears the header inset and its preview stays inside the sidebar", async ({
  page,
}) => {
  await stageSidebarTasks(page, "light");
  await page.setViewportSize({ width: 1440, height: 500 });
  await page.goto("/new");
  const nav = page.getByRole("navigation", { name: "Threads" });
  const viewport = nav.locator("[data-virtual-viewport]");
  const first = nav.getByRole("link", { name: /^yo!/ });
  await first.focus();
  const viewportBox = await viewport.boundingBox();
  const firstBox = await first.boundingBox();
  if (!viewportBox || !firstBox) throw new Error("Missing sidebar bounds");
  expect(firstBox.y).toBeGreaterThanOrEqual(viewportBox.y + 8);
  const last = nav.getByRole("link", { name: /^independent browser-path/ });
  await last.focus();
  await page.keyboard.press("ArrowUp");
  const details = page.getByLabel(/^Details for /);
  await expect(details).toBeVisible();
  const preview = await details.boundingBox();
  if (!preview) throw new Error("Missing preview bounds");
  expect(preview.x).toBeGreaterThanOrEqual(viewportBox.x);
  expect(preview.x + preview.width).toBeLessThanOrEqual(viewportBox.x + viewportBox.width);
  expect(preview.y).toBeGreaterThanOrEqual(8);
  expect(preview.y + preview.height).toBeLessThanOrEqual(492);
});

test.describe("coarse pointer task rows", () => {
  test.use({ hasTouch: true, viewport: { width: 390, height: 900 } });
  test("task and settled links keep finger-sized targets", async ({ page }) => {
    await stageSidebarTasks(page);
    await page.goto("/t/sidebar-3");
    await page.getByRole("button", { name: "Back to threads" }).click();
    const nav = page.getByRole("navigation", { name: "Threads" });
    const task = nav.getByRole("link", { name: /^Audit Console/ });
    await expect(task.getByText("Working", { exact: true })).toBeVisible();
    expect((await task.boundingBox())?.height).toBeGreaterThanOrEqual(72);
    await nav.getByRole("button", { name: "Settled (1)" }).click();
    const settled = nav.getByRole("link", { name: /^Build Agent State Engine/ });
    await expect(settled).toBeVisible();
    expect((await settled.boundingBox())?.height).toBeGreaterThanOrEqual(44);
    await expect(settled.getByText("OpenForge", { exact: true })).toBeVisible();
  });
});

test("fake provider variants identify themselves before the repeated task text", async ({
  page,
}) => {
  await page.addInitScript(() =>
    localStorage.setItem(
      "ace.home.organizer",
      JSON.stringify({ project: "acme", baseline: 0, settledOpen: false }),
    ),
  );
  await page.goto("/new?project=acme");
  const nav = page.getByRole("navigation", { name: "Threads" });
  const variants = nav.getByRole("link", { name: /Capture the document window/ });
  await expect(variants).toHaveCount(6);
  const names = await variants.evaluateAll((links) =>
    links.map((link) => link.getAttribute("aria-label")?.split(". ")[0]),
  );
  expect(new Set(names).size).toBe(6);
  expect(
    names.every((name) =>
      /^(Claude Code|Codex|OpenCode|Pi|Cursor|ACP agent) · Capture the document window/.test(
        name ?? "",
      ),
    ),
  ).toBe(true);
});
