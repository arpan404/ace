import { expect, test } from "@playwright/test";

for (const theme of ["light", "dark", "midnight", "graphite", "paper", "slate", "contrast"]) {
  test(`notifications stay above the mobile composer and can be dismissed in ${theme}`, async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.addInitScript((preset) => {
      localStorage.setItem(
        "ace.appearance",
        JSON.stringify({
          theme: preset,
          accent: "theme",
          glass: 1,
          density: "comfortable",
          transcriptSize: "default",
        }),
      );
    }, theme);
    await page.goto("/t/thread-cold-start");
    await page.getByRole("button", { name: "More actions" }).click();
    await page.getByRole("button", { name: "More options" }).click();
    await page.getByRole("menuitem", { name: /^Rename/ }).click();
    await page.getByRole("textbox", { name: "Thread title" }).fill("Toast clearance");
    await page.getByRole("button", { name: "Rename", exact: true }).click();
    const notifications = page.getByRole("region", { name: "Notifications", exact: true });
    await expect(
      notifications.getByText("Renamed · Toast clearance", { exact: true }),
    ).toBeVisible();
    const notification = notifications.getByRole("dialog", {
      name: "Renamed · Toast clearance",
      exact: true,
    });
    const message = page.getByRole("combobox", { name: "Message", exact: true });
    const clearance = async () => {
      const toast = await notification.boundingBox();
      const input = await message.boundingBox();
      if (!toast || !input) throw new Error("The notification or message input is not visible");
      return input.y - toast.y - toast.height;
    };
    await expect.poll(clearance).toBeGreaterThan(0);
    await message.fill("One line\nTwo lines\nThree lines\nFour lines");
    await expect.poll(clearance).toBeGreaterThan(0);
    await notification.getByRole("button", { name: "Dismiss", exact: true }).click();
    await expect(page.getByText("Renamed · Toast clearance", { exact: true })).toBeHidden();
  });
}
