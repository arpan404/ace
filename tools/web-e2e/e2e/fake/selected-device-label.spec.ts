import { expect, test } from "@playwright/test";

test("the selected device name hides in a narrow sidebar and remains available on hover", async ({
  page,
}, info) => {
  test.setTimeout(60_000);
  await page.goto("/new?project=chat");
  await page.getByRole("button", { name: "Project filter: All projects", exact: true }).click();
  await page.getByRole("menuitem", { name: "Device filter: All devices" }).hover();
  await page.getByRole("menuitemradio", { name: "Build server", exact: true }).click();
  const control = page.getByRole("button", {
    name: "Project filter: All projects, Device: Build server",
    exact: true,
  });
  const name = control.locator("[data-selected-device-name]");
  const resize = page.getByRole("separator", { name: "Resize sidebar", exact: true });
  await expect(name).toBeVisible();
  await expect(name).toHaveText("Build server");
  for (const colorScheme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme });
    await expect(page.locator("html")).toHaveAttribute("data-scheme", colorScheme);
    await resize.press("Home");
    for (let step = 0; step < 7; step++) await resize.press("ArrowRight");
    await expect(name).toBeVisible();
    await page.getByRole("combobox", { name: "Message" }).click();
    await page.screenshot({
      path: info.outputPath(`selected-device-${colorScheme}.png`),
      animations: "disabled",
    });
    await resize.press("Home");
    await expect(name).toBeHidden();
    await page.getByRole("combobox", { name: "Message" }).click();
    await control.hover();
    await expect(page.getByRole("tooltip")).toHaveText("Build server");
    await page.screenshot({
      path: info.outputPath(`compact-device-${colorScheme}.png`),
      animations: "disabled",
    });
    await page.getByRole("combobox", { name: "Message" }).hover();
  }
});
