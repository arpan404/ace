import { expect, test } from "@playwright/test";

test("an empty chat has no top strip, while project controls still show", async ({
  page,
}, info) => {
  await page.goto("/new?project=chat");
  await page.getByRole("combobox", { name: "Message" }).waitFor();
  const strip = page.locator(".ace-glass-attached");
  for (const colorScheme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme });
    await expect(page.locator("html")).toHaveAttribute("data-scheme", colorScheme);
    for (const width of [390, 768, 1440, 1920]) {
      await page.setViewportSize({ width, height: 900 });
      await expect(strip).toBeHidden();
      // Let the responsive composer and glass geometry settle after each resize.
      await page.waitForTimeout(300);
      await page.screenshot({
        path: info.outputPath(`chat-${colorScheme}-${width}.png`),
        animations: "disabled",
      });
    }
  }
  await page.goto("/new?project=relay");
  await expect(page.getByRole("region", { name: "Where this thread runs" })).toBeVisible();
  await expect(strip).toBeVisible();
});

test("a chat still shows its save warning above the composer", async ({ page }) => {
  await page.goto("/new?project=chat");
  const message = page.getByRole("combobox", { name: "Message" });
  await message.waitFor();
  await page.evaluate(() => {
    const save = Storage.prototype.setItem;
    Storage.prototype.setItem = function (key, value) {
      if (key === "ace.composer.drafts") throw new Error("Storage full");
      save.call(this, key, value);
    };
  });
  await message.fill("Keep this draft");
  await expect(page.getByRole("alert")).toContainText("Couldn't save this preparation");
  await expect(page.locator(".ace-glass-attached")).toBeVisible();
});
