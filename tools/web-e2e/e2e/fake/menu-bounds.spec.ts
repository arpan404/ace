import { expect, test, type Locator, type Page } from "@playwright/test";

async function navigateTo(page: Page, item: Locator) {
  await page.keyboard.press("Home");
  for (let step = 0; step < 25; step++) {
    if (await item.evaluate((element) => element === document.activeElement)) break;
    await page.keyboard.press("ArrowDown");
  }
  await expect(item).toBeFocused();
  await page.keyboard.press("ArrowRight");
}

async function insideViewport(popup: Locator, width: number, height: number) {
  await expect(async () => {
    const box = await popup.boundingBox();
    expect(box).not.toBeNull();
    if (!box) return;
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.y).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(width);
    expect(box.y + box.height).toBeLessThanOrEqual(height);
  }).toPass();
}

for (const viewport of [
  { width: 1440, height: 500 },
  { width: 720, height: 250 },
  { width: 390, height: 500 },
])
  test(`long header menu and its submenus remain usable in ${viewport.width}×${viewport.height}`, async ({
    page,
  }) => {
    await page.setViewportSize(viewport);
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto("/t/thread-dedupe?fakeWorld=thread-activity");
    await expect(page.getByRole("combobox", { name: "Message", exact: true })).toBeVisible();
    await page.getByRole("button", { name: "More actions", exact: true }).first().click();
    const more = page.getByRole("button", { name: "More options", exact: true });
    if (await more.isVisible()) await more.click();
    await expect(page.getByRole("menuitem", { name: "Copy link", exact: true })).toBeVisible();
    const menu = page.locator('[data-slot="menu-content"]').first();
    await insideViewport(menu, viewport.width, viewport.height);
    await expect(async () => {
      const sizes = await menu.evaluate((element) => ({
        content: element.scrollHeight,
        visible: element.clientHeight,
      }));
      expect(sizes.content).toBeGreaterThan(sizes.visible);
    }).toPass();
    await page.keyboard.press("End");
    const last = page.getByRole("menuitem", { name: "Delete thread", exact: true });
    await expect(last).toBeFocused();
    await expect(async () => {
      const outer = await menu.boundingBox();
      const item = await last.boundingBox();
      expect(outer).not.toBeNull();
      expect(item).not.toBeNull();
      if (!outer || !item) return;
      expect(item.y).toBeGreaterThanOrEqual(outer.y);
      expect(item.y + item.height).toBeLessThanOrEqual(outer.y + outer.height);
    }).toPass();
    const snooze = page.getByRole("menuitem", { name: "Snooze", exact: true });
    await navigateTo(page, snooze);
    await expect(page.locator('[data-slot="menu-content"]')).toHaveCount(2);
    await insideViewport(
      page.locator('[data-slot="menu-content"]').last(),
      viewport.width,
      viewport.height,
    );
    await expect(
      page.locator('[data-slot="menu-content"]').last().getByRole("menuitem").first(),
    ).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(snooze).toBeFocused();
    await navigateTo(page, page.getByRole("menuitem", { name: "Open in…", exact: true }));
    await expect(page.locator('[data-slot="menu-content"]')).toHaveCount(2);
    await insideViewport(
      page.locator('[data-slot="menu-content"]').last(),
      viewport.width,
      viewport.height,
    );
    expect(errors).toEqual([]);
  });
