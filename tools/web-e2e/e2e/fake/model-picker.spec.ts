import { expect, test, type Page } from "@playwright/test";

/*
 * The model chip's popover in a real browser: it tracks its trigger through pane resizes,
 * and the picker keeps one size while its content changes.
 */

interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

async function box(page: Page, selector: string): Promise<Box> {
  const found = await page.locator(selector).first().boundingBox();
  if (!found) throw new Error(`${selector} isn't laid out`);
  return found;
}

async function openPicker(page: Page) {
  await page.goto("/t/thread-replay-cursor");
  await page.getByRole("button", { name: /^Model: / }).click();
  await page.getByRole("button", { name: /^Change model/ }).click();
  await expect(page.getByRole("combobox", { name: "Search models" })).toBeFocused();
}

test("the model popover stays anchored to the chip with an approval and Files pane", async ({
  page,
}) => {
  await page.goto("/t/thread-refund-tax");
  await page.getByRole("button", { name: "Right panel" }).click();
  await page
    .getByRole("region", { name: "Thread panel" })
    .getByRole("tab", { name: "Files", exact: true })
    .click();
  const chip = page.getByRole("button", { name: /^Model: / });
  await chip.click();
  const anchored = async () => {
    const popup = await box(page, '[data-slot=popover-content][aria-label="Model and effort"]');
    const trigger = await chip.boundingBox();
    if (!trigger) throw new Error("model trigger missing");
    expect(Math.abs(trigger.y - popup.y - popup.height - 8)).toBeLessThanOrEqual(1);
    expect(popup.x).toBeGreaterThanOrEqual(0);
    expect(popup.x + popup.width).toBeLessThanOrEqual(page.viewportSize()!.width);
    const column = await box(page, "[data-thread-column]");
    expect(popup.x).toBeGreaterThanOrEqual(column.x);
    expect(popup.x + popup.width).toBeLessThanOrEqual(column.x + column.width);
    expect(trigger.x + trigger.width).toBeGreaterThan(popup.x);
    expect(trigger.x).toBeLessThan(popup.x + popup.width);
  };
  await expect(anchored).toPass();
  await page.setViewportSize({ width: 1200, height: 800 });
  await expect(anchored).toPass();
});

test("the picker keeps its size and its search in place across tabs, a search and a star", async ({
  page,
}) => {
  await openPicker(page);
  const panel = "[data-slot=model-picker]";
  const search = page.getByRole("combobox", { name: "Search models" });
  const first = await box(page, panel);
  const firstSearch = await search.boundingBox();
  const same = async () => {
    expect(await box(page, panel)).toEqual(first);
    expect(await search.boundingBox()).toEqual(firstSearch);
  };

  await page.getByRole("tab", { name: "Codex · Personal", exact: true }).click();
  await same();
  await search.fill("sonnet");
  await same();
  await search.fill("no model is called this");
  await expect(page.getByText("No models match")).toBeVisible();
  await same();
  await search.fill("");
  await page.getByRole("tab", { name: "Favorites" }).click();
  await expect(page.getByText("No favorites yet")).toBeVisible();
  await same();
  await page.getByRole("tab", { name: "Claude Code · Work", exact: true }).click();
  await page.getByRole("option", { name: "Haiku 4.5, Claude Code" }).hover();
  await page.getByRole("button", { name: "Add Haiku 4.5 to favorites" }).click();
  await page.getByRole("tab", { name: "Favorites" }).click();
  await expect(page.getByRole("option", { name: "Haiku 4.5, Claude Code" })).toBeVisible();
  await same();
});
