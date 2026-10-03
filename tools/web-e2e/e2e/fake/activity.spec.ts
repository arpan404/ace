import { expect, test } from "@playwright/test";

test("an approval is answered from Activity and leaves the needs-you list", async ({ page }) => {
  await page.goto("/activity");
  const main = page.getByRole("main");
  const card = main.getByRole("article", { name: "Allow a force push to fix/restart-retry?" });
  await expect(
    card.getByText("git push --force-with-lease origin fix/restart-retry"),
  ).toBeVisible();

  await card.getByRole("button", { name: "Approve" }).click();

  await expect(card).toHaveCount(0);
  await expect(page.getByRole("banner").getByText("5 need you")).toBeVisible();
});
