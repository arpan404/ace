import { expect, test } from "@playwright/test";

test("approving a card's merge lifts the deck's gate", async ({ page }) => {
  await page.goto("/offshifts");
  await expect(
    page.getByRole("heading", { level: 1, name: "Resumable relay streams" }),
  ).toBeVisible();
  const gate = page.getByRole("region", {
    name: "Merge needs your approval: Server-side replay cursor",
  });
  await gate.getByRole("button", { name: "Approve merge" }).click();

  await expect(gate).toHaveCount(0);
  const decks = page.getByRole("navigation", { name: "Offshifts" });
  await expect(
    decks.getByRole("region", { name: "Needs you" }).getByRole("link", { name: /Resumable/ }),
  ).toHaveCount(0);
});

test("a new deck starts planning and opens its run", async ({ page }) => {
  await page.goto("/offshifts/new");
  const form = page.getByRole("form", { name: "New offshift" });
  await form
    .getByLabel("Goal")
    .fill("Add retry budgets to every relay reconnect path, with a regression test for each.");
  await form.getByRole("button", { name: /Start offshift/ }).click();

  await expect(page).toHaveURL(/\/offshifts\/[^/]+$/);
  await expect(page.getByRole("banner")).toContainText("Offshifts");
  const decks = page.getByRole("navigation", { name: "Offshifts" });
  await expect(decks.getByRole("link", { name: /Add retry budgets/ })).toBeVisible();
});
