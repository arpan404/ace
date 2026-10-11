import { expect, type Page } from "@playwright/test";

/** Real app controls against production CSS. Run after capturing performance measurements. */
export async function verifyPopoverToasts(page: Page): Promise<void> {
  const viewport = page.locator('[data-slot="toast-viewport"]');
  const visibility = () => viewport.evaluate((node) => getComputedStyle(node).visibility);
  const more = page.getByRole("banner").getByRole("button", { name: "More actions" });
  const notice = page.getByRole("heading", { name: "Couldn't pin the thread", exact: true });
  const showNotice = async () => {
    // The soak daemon rejects organization commands. Exercise that real error path so the
    // deferred renderer has a notice to show; hovering pauses its timer between popup cycles.
    await more.click();
    await page.getByRole("menuitem", { name: /^Pin/ }).click();
    await expect(notice.last()).toBeVisible();
    await notice.last().hover();
    await expect.poll(visibility).toBe("visible");
  };
  const checkModel = async () => {
    await page.getByRole("button", { name: /^Model:/ }).click();
    const model = page.getByRole("dialog", { name: "Model and effort" });
    await expect(model).toBeVisible();
    await expect(model.getByRole("combobox", { name: "Search models" })).toBeVisible();
    await expect.poll(visibility).toBe("hidden");
    await page.keyboard.press("Escape");
    await expect(model).not.toBeVisible();
    await expect.poll(visibility).toBe("visible");
    await notice.last().hover();
  };

  await showNotice();
  await checkModel();
  await page.setViewportSize({ width: 390, height: 900 });
  await showNotice();
  await checkModel();

  // On a phone, Work card remains in the header and More actions opens a menu. Menus close
  // by unmounting; the old kept-mounted header popover is no longer part of this journey.
  await expect(page.getByRole("banner").getByRole("button", { name: /^Work card/ })).toBeVisible();
  await expect(more).toHaveAttribute("aria-expanded", "false");
  await more.click();
  const menu = page.getByRole("menu");
  await expect(menu).toBeVisible();
  await expect(more).toHaveAttribute("aria-expanded", "true");
  await expect(menu.getByRole("menuitem", { name: /^Pin/ })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(menu).toHaveCount(0);
  await expect(more).toHaveAttribute("aria-expanded", "false");
  await expect(more).toBeFocused();
  await expect.poll(visibility).toBe("visible");
  console.log(
    "  desktop and phone popover notification visibility and header menu closure: passed",
  );
}
