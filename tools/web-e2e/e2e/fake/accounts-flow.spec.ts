import { expect, test } from "@playwright/test";

for (const width of [1440, 390]) {
  test(`at ${width}px the new-thread picker opens downward without moving the page out of view`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.goto("/new?project=ace");
    const heading = page.getByRole("heading", { name: /^What should we work on in / });
    await expect(heading).toBeVisible();
    const chip = page.getByRole("button", { name: /^Model: / });
    await expect(chip).toBeEnabled();
    await chip.click();
    const dialog = page.getByRole("dialog", { name: "Model and effort" });
    await dialog.getByRole("button", { name: /^Change model/ }).click();
    const search = dialog.getByRole("combobox", { name: "Search models" });
    await expect(search).toBeFocused();
    await expect.poll(async () => (await heading.boundingBox())?.x ?? -1).toBeGreaterThanOrEqual(0);
    const chipBox = await chip.boundingBox();
    if (!chipBox) throw new Error("Model choice is not visible");
    await expect
      .poll(async () => (await search.boundingBox())?.y ?? -1)
      .toBeGreaterThanOrEqual(chipBox.y + chipBox.height);
    await search.fill("sonnet");
    await expect(dialog.getByRole("option").first()).toBeVisible();
    await expect.poll(async () => (await heading.boundingBox())?.x ?? -1).toBeGreaterThanOrEqual(0);
  });

  test(`at ${width}px the current limited account stays selected and reset recovery remains clickable`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.goto("/t/thread-limit-flags");
    const resume = page.getByRole("button", { name: "Resume at reset", exact: true });
    await expect(resume).toBeVisible();
    await page.getByRole("button", { name: /^Model: / }).click();
    const dialog = page.getByRole("dialog", { name: "Model and effort" });
    await dialog.getByRole("combobox", { name: "Account" }).click();
    const selected = page.getByRole("option", { name: "Team · Limit reached" });
    await expect(selected).toHaveAttribute("aria-selected", "true");
    await expect(selected).toBeEnabled();
    await selected.click();
    await expect(dialog).toBeVisible();
    await expect
      .poll(() =>
        resume.evaluate((button) => {
          const rect = button.getBoundingClientRect();
          return button.contains(
            document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2),
          );
        }),
      )
      .toBe(true);
    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
    await resume.click();
    await expect(page.getByRole("region", { name: "Resumes when the limit resets" })).toBeVisible();
  });
}
