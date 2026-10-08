import { expect, test, type Locator, type Page } from "@playwright/test";
import { stageSidebarTasks } from "./sidebar-tasks.fixture.ts";
import { scrollToRow } from "./thread-list.ts";

/**
 * Pinning, dragging and picking threads in Home's list, against the fake daemon (which answers
 * the same organize commands as apps/daemon).
 */
const threads = (page: Page) => page.getByRole("navigation", { name: "Threads" });
const row = (page: Page, title: RegExp) => threads(page).getByRole("link", { name: title });
const pinnedHeading = (page: Page) => threads(page).getByText(/^Pinned \d+$/);

/** The threads of the Pinned group, top to bottom, by id. */
async function pinnedGroup(page: Page): Promise<string[]> {
  const heading = (await pinnedHeading(page).textContent()) ?? "";
  const count = Number(/(\d+)$/.exec(heading)?.[1] ?? 0);
  const paths = await threads(page)
    .getByRole("link")
    .evaluateAll((rows) => rows.map((element) => element.getAttribute("href") ?? ""));
  return paths.slice(0, count).map((path) => decodeURIComponent(path.split("/").at(-1) ?? ""));
}

/** Where `row` is once the list has stopped sliding (rows glide to new places after a change). */
async function settledBox(target: Locator) {
  let last = "";
  let box: Awaited<ReturnType<Locator["boundingBox"]>> = null;
  await expect
    .poll(async () => {
      box = await target.boundingBox();
      const now = JSON.stringify(box);
      const still = now === last;
      last = now;
      return still;
    })
    .toBe(true);
  if (!box) throw new Error("row not on screen");
  return box as { x: number; y: number; width: number; height: number };
}

/** Press on `source` and drag it so the pointer ends at `toY` (page coordinates). */
async function drag(page: Page, source: Locator, toY: number) {
  const box = await settledBox(source);
  const x = box.x + 40;
  await page.mouse.move(x, box.y + box.height / 2);
  await page.mouse.down();
  // The first move loads its small I/O shell. Keep moving until the grabbing cursor appears.
  await expect(async () => {
    await page.mouse.move(x + 8, box.y + box.height / 2 + 8, { steps: 3 });
    await page.mouse.move(x, box.y + box.height / 2 + 10, { steps: 3 });
    expect(await page.evaluate(() => getComputedStyle(document.body).cursor)).toBe("grabbing");
  }).toPass();
  await page.mouse.move(x, toY, { steps: 12 });
  await page.mouse.up();
}

test("pin from the row and by key, drag to reorder and out of the group, with Undo", async ({
  page,
}) => {
  await stageSidebarTasks(page);
  await page.goto("/t/sidebar-3");
  await row(page, /^greeting/).hover();
  await row(page, /^greeting/).click({ button: "right" });
  await page.getByRole("menuitem", { name: /^Pin/ }).click();
  await expect(pinnedHeading(page)).toHaveText("Pinned 1");

  await row(page, /^yo!/).focus();
  await page.keyboard.press("p");
  await expect(pinnedHeading(page)).toHaveText("Pinned 2");
  // A new pin leads the group.
  await expect.poll(() => pinnedGroup(page)).toEqual(["sidebar-0", "sidebar-1"]);

  // Drag greeting above yo!: the order holds, and the row doesn't open.
  const url = page.url();
  const top = await settledBox(row(page, /^yo!/));
  await drag(page, row(page, /^greeting/), top.y + 6);
  await expect.poll(() => pinnedGroup(page)).toEqual(["sidebar-1", "sidebar-0"]);
  expect(page.url()).toBe(url);

  // Drag yo! below the group: it unpins, and Undo puts it back where it was.
  const below = await settledBox(row(page, /^Audit Console/));
  await drag(page, row(page, /^yo!/), below.y + 30);
  await expect(pinnedHeading(page)).toHaveText("Pinned 1");
  await page.getByRole("button", { name: "Undo" }).click();
  await expect(pinnedHeading(page)).toHaveText("Pinned 2");
  await expect.poll(() => pinnedGroup(page)).toEqual(["sidebar-1", "sidebar-0"]);
});

test("a keyboard move: Space picks the row up, arrows choose, Space drops", async ({ page }) => {
  await stageSidebarTasks(page);
  await page.goto("/t/sidebar-3");
  for (const title of [/^greeting/, /^yo!/]) {
    await row(page, title).focus();
    await page.keyboard.press("p");
  }
  await expect(pinnedHeading(page)).toHaveText("Pinned 2");
  await row(page, /^yo!/).focus();
  await page.keyboard.press("Space");
  const live = threads(page).locator("[aria-live]").first();
  await expect(live).toHaveText(/^Moving yo!.*place 1 of 2/);
  await page.keyboard.press("ArrowDown");
  await expect(live).toHaveText(/place 2 of 2/);
  await page.keyboard.press("Space");
  await expect.poll(() => pinnedGroup(page)).toEqual(["sidebar-1", "sidebar-0"]);
});

test("⌘-click picks threads; bulk Archive asks, archives them all, and Undo brings them back", async ({
  page,
}) => {
  await stageSidebarTasks(page);
  await page.goto("/t/sidebar-3");
  const modifier = process.platform === "darwin" ? "Meta" : "Control";
  await row(page, /^greeting/).click({ modifiers: [modifier] });
  await row(page, /^Hi bro/).click({ modifiers: [modifier] });
  const bar = page.getByRole("toolbar", { name: "Selected threads" });
  await expect(bar).toContainText("2 selected");
  await bar.getByRole("button", { name: "Archive 2 threads…" }).click();
  const dialog = page.getByRole("dialog", { name: "Archive 2 threads?" });
  await dialog.getByRole("button", { name: "Archive 2 threads" }).click();
  await expect(row(page, /^greeting/)).toHaveCount(0);
  await expect(row(page, /^Hi bro/)).toHaveCount(0);
  await page.getByRole("button", { name: "Undo" }).click();
  await scrollToRow(page, row(page, /^greeting/));
  await scrollToRow(page, row(page, /^Hi bro/));
});
