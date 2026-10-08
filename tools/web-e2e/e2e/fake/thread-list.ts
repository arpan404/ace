import { expect, type Locator, type Page } from "@playwright/test";

/**
 * Scroll Home's thread list until `row` shows, as a person would. The list is virtual, so a
 * row below the fold isn't in the page until it scrolls into view.
 */
export async function scrollToRow(page: Page, row: Locator): Promise<void> {
  await page.getByRole("complementary", { name: "Threads" }).hover();
  await expect(async () => {
    if (!(await row.isVisible())) await page.mouse.wheel(0, 300);
    await expect(row).toBeVisible({ timeout: 500 });
  }).toPass();
}
