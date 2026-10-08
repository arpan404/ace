import { expect, test } from "@playwright/test";

for (const width of [1440, 390]) {
  test(`archiving with ⇧⌘A never leaves Allow focused at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.goto("/t/thread-install-page");
    await page.getByRole("button", { name: "More actions", exact: true }).click();
    if (width === 390)
      await page.getByRole("button", { name: "More options", exact: true }).click();
    await page.getByRole("menuitem", { name: /^Archive/ }).waitFor();
    await page.keyboard.press("Escape");
    if (width === 390) await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await page.keyboard.press("Meta+Shift+a");
    const waiting = page.getByRole("region", { name: "Waiting for you" });
    const deny = waiting.getByRole("button", { name: "Deny", exact: true });
    await expect(deny).toBeVisible();
    if (width === 1440) await expect(deny).toBeFocused();
    else await expect(waiting.getByRole("button", { name: "Allow once" })).not.toBeFocused();
    await deny.focus();
    await page.keyboard.press("1");
    await expect(waiting.getByText(/Read the request/)).toBeVisible();
    await expect(deny).toBeVisible();
    await page.keyboard.press("Enter");
    await expect(waiting).toHaveCount(0);
  });
}
