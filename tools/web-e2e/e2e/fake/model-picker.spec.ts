import { expect, test, type Page } from "@playwright/test";

/*
 * The model chip's popover in a real browser, where layout exists: it opens above the composer
 * rather than over the message, and the picker keeps one size while its content changes.
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

test("the model popover opens above the composer, lined up with the chip", async ({ page }) => {
  await page.goto("/t/thread-replay-cursor");
  const chip = page.getByRole("button", { name: /^Model: / });
  await chip.click();
  await expect(page.getByRole("slider", { name: "Effort" })).toBeVisible();
  const popover = await box(page, "[data-slot=popover-content]");
  const composer = await box(page, "[data-slot=composer]");
  const chipBox = await chip.boundingBox();
  expect(popover.y + popover.height).toBeLessThanOrEqual(composer.y);
  expect(Math.abs(popover.x - (chipBox?.x ?? 0))).toBeLessThanOrEqual(1);
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

  await page.getByRole("tab", { name: "Codex" }).click();
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
  await page.getByRole("tab", { name: "Claude Code" }).click();
  await page.getByRole("option", { name: "Haiku 4.5, Claude Code" }).hover();
  await page.getByRole("button", { name: "Add Haiku 4.5 to favorites" }).click();
  await page.getByRole("tab", { name: "Favorites" }).click();
  await expect(page.getByRole("option", { name: "Haiku 4.5, Claude Code" })).toBeVisible();
  await same();
});
