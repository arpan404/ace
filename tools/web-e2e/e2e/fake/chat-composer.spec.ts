import { expect, test, type Page } from "@playwright/test";

// Cold Vite compilation and the responsive screenshot pass can exceed the default deadline.
test.setTimeout(60_000);

async function openDeviceMenu(page: Page) {
  await page.getByRole("button", { name: /^Project filter:/ }).click();
  await page.getByRole("menuitem", { name: /^Device filter:/ }).click();
  await expect(page.getByRole("menuitemradio", { name: "All devices", exact: true })).toBeVisible();
  const projects = await page.getByRole("menu").nth(0).boundingBox();
  const devices = await page.getByRole("menu").nth(1).boundingBox();
  if (!projects || !devices) throw new Error("Missing filter menus");
  expect(devices.x).toBeGreaterThanOrEqual(projects.x + projects.width - 1);
}

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

test("the sidebar device filter shows only the selected device's threads", async ({
  page,
}, info) => {
  await page.goto("/new?project=chat");
  await page.getByRole("combobox", { name: "Message" }).waitFor();
  await page.setViewportSize({ width: 1440, height: 900 });
  await expect(page.getByRole("button", { name: /^Device filter:/ })).toHaveCount(0);
  await openDeviceMenu(page);
  await page.getByRole("menuitemradio", { name: "Build server", exact: true }).click();
  await page.keyboard.press("Escape");
  const threads = page.getByRole("navigation", { name: "Threads", exact: true });
  await expect(threads.getByRole("link", { name: /^Add rate limits to the api\./ })).toBeVisible();
  await expect(threads.getByRole("link", { name: /^Fix flaky checkout test\./ })).toBeHidden();
  for (const colorScheme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme });
    await expect(page.locator("html")).toHaveAttribute("data-scheme", colorScheme);
    await page.screenshot({
      path: info.outputPath(`device-filter-${colorScheme}.png`),
      animations: "disabled",
    });
    await openDeviceMenu(page);
    await expect(
      page.getByRole("menuitemradio", { name: "Build server", exact: true }),
    ).toBeVisible();
    await page.screenshot({
      path: info.outputPath(`device-menu-${colorScheme}.png`),
      animations: "disabled",
    });
    await page.keyboard.press("Escape");
    await page.keyboard.press("Escape");
  }
  await openDeviceMenu(page);
  await page.getByRole("menuitemradio", { name: "All devices", exact: true }).click();
  await page.keyboard.press("Escape");
  await expect(threads.getByRole("link", { name: /^Fix flaky checkout test\./ })).toBeVisible();
});
