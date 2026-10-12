import { expect, test } from "@playwright/test";

const background = (page: import("@playwright/test").Page) =>
  page.evaluate(() =>
    getComputedStyle(document.documentElement).getPropertyValue("--background").trim(),
  );

test("mode and theme restyle the app at once and survive a reload", async ({ page }) => {
  await page.goto("/settings/appearance");
  await page.getByRole("button", { name: "Light", exact: true }).click();
  await expect(page.locator("html")).toHaveAttribute("data-scheme", "light");
  const light = await background(page);
  await page.getByRole("button", { name: "Dark", exact: true }).click();
  await expect(page.locator("html")).toHaveAttribute("data-scheme", "dark");
  await expect.poll(() => background(page)).not.toBe(light);

  await page.getByRole("radio", { name: "Paper", exact: true }).click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "paper");
  await page.reload();
  // index.html replays the choice before the app's script runs.
  await expect(page.locator("html")).toHaveAttribute("data-theme", "paper");
  await expect(page.locator("html")).toHaveAttribute("data-scheme", "dark");
  await expect(page.getByRole("radio", { name: "Paper", exact: true })).toBeChecked();
});
