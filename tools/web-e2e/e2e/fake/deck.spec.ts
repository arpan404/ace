import { expect, test } from "@playwright/test";

test("approving a gated deck plan lifts the gate", async ({ page }) => {
  await page.goto("/deck");
  await expect(
    page.getByRole("heading", { level: 1, name: "Resumable relay streams" }),
  ).toBeVisible();
  const gate = page.getByRole("region", { name: "Deck plan needs your approval" });
  await gate.getByRole("button", { name: "Approve plan" }).click();

  await expect(gate).toHaveCount(0);
  const decks = page.getByRole("navigation", { name: "Decks" });
  await expect(
    decks.getByRole("region", { name: "Gated" }).getByRole("link", { name: /Resumable/ }),
  ).toHaveCount(0);
});

test("a new deck starts planning and opens its run", async ({ page }) => {
  await page.goto("/deck/new");
  const form = page.getByRole("form", { name: "New deck" });
  await form
    .getByLabel("Goal")
    .fill("Add retry budgets to every relay reconnect path, with a regression test for each.");
  await form.getByRole("button", { name: /Start deck/ }).click();

  await expect(page).toHaveURL(/\/deck\/[^/]+$/);
  await expect(page.getByRole("banner")).toContainText("Deck");
  const decks = page.getByRole("navigation", { name: "Decks" });
  await expect(decks.getByRole("link", { name: /Add retry budgets/ })).toBeVisible();
});
