import { expect, test } from "@playwright/test";

const background = (page: import("@playwright/test").Page) =>
  page.evaluate(() =>
    getComputedStyle(document.documentElement).getPropertyValue("--background").trim(),
  );

test("switching to Light and editing a token restyles the app", async ({ page }) => {
  await page.goto("/settings/appearance");
  await page.getByRole("radio", { name: "Light" }).click();
  await expect.poll(() => background(page)).not.toBe("#0F0F0F");
  const light = await background(page);

  await page.getByRole("link", { name: "Advanced › Theme editor" }).click();
  await expect(page.getByRole("heading", { level: 2, name: "Theme editor" })).toBeVisible();
  await expect(page.getByRole("combobox", { name: "Theme to edit" })).toContainText("Light");
  const field = page.getByRole("textbox", { name: "--background", exact: true });
  await expect(field).toHaveValue(new RegExp(light, "i"));

  await field.fill("#FAF7F0");
  await field.press("Enter");

  await expect.poll(() => background(page)).toMatch(/#faf7f0/i);
  // The first edit to a preset forks a custom copy, which is now the live theme.
  await expect(page.getByRole("combobox", { name: "Theme to edit" })).toContainText(/custom/i);
});
