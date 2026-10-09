import { expect, test } from "@playwright/test";

test("the conversation rail previews both sides of a turn and jumps with pointer and keyboard", async ({
  page,
}) => {
  await page.goto("/t/thread-multi-day");
  const rail = page.getByRole("navigation", { name: "Conversation turns" });
  await expect(rail).toBeVisible();
  await expect(rail.getByRole("button")).toHaveCount(24);
  const third = rail.getByRole("button", { name: /^Turn 3:/ });
  await third.hover();
  const preview = page.locator('[data-slot="hover-card-content"]');
  await expect(preview).toContainText("Migrate checkpoint 3, inspect files and report failures.");
  await expect(preview).toContainText("Checkpoint 3 completed.");
  await third.click();
  await expect(page.getByRole("status", { name: "Jumped" })).toContainText("Jumped to turn 3");
  await expect(third).toHaveAttribute("aria-current", "location");
  await third.focus();
  await page.keyboard.press("ArrowDown");
  const fourth = rail.getByRole("button", { name: /^Turn 4:/ });
  await expect(fourth).toBeFocused();
  await expect(preview).toContainText("Migrate checkpoint 4, inspect files and report failures.");
  await page.keyboard.press("Enter");
  await expect(page.getByRole("status", { name: "Jumped" })).toContainText("Jumped to turn 4");
  await expect(fourth).toHaveAttribute("aria-current", "location");
  await page.mouse.move(600, 70);
  await page.getByRole("combobox", { name: "Message", exact: true }).focus();
  await expect(preview).toHaveCount(0);
  await page.screenshot({ animations: "disabled", path: "/tmp/ace-conversation-rail.png" });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(rail).toBeHidden();
  await expect(page.getByRole("combobox", { name: "Message", exact: true })).toBeVisible();
});
