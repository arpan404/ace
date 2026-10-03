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
