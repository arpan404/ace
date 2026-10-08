import { expect, test } from "@playwright/test";

/*
 * A Home row's marks give way to Settle and Snooze on hover and focus. What they mean must stay
 * in the row's accessible name (with the page's real styles applied) and in its tooltip.
 */
test("a focused or hovered row keeps saying its status, and its tooltip what the marks mean", async ({
  page,
}) => {
  await page.goto("/t/thread-dedupe");
  const threads = page.getByRole("navigation", { name: "Threads" });
  const row = threads.getByRole("link", { name: /^Partial refunds double-count tax/ });
  await row.focus();
  await expect(row).toHaveAccessibleName(/Waiting for your approval.*Pull request #77/);
  await expect(page.getByRole("tooltip")).toContainText("Pull request #77");

  await page.getByRole("combobox", { name: "Message" }).focus();
  await row.hover();
  await expect(row).toHaveAccessibleName(/Waiting for your approval.*Pull request #77/);
  await expect(page.getByRole("tooltip")).toContainText("Waiting for your approval");
});
