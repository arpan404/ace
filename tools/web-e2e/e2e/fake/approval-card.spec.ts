import { expect, test, type Locator, type Page } from "@playwright/test";

/**
 * Wait for the card to finish rising from behind the composer. A pointer can't reach a card
 * mid-rise anyway, and Playwright's click would scroll the shell to it.
 */
const settled = (page: Page) =>
  page.evaluate(() =>
    Promise.all(
      document
        .getAnimations()
        .filter((animation) => animation.effect?.getComputedTiming().endTime !== Infinity)
        .map((animation) => animation.finished),
    ),
  );

/** The point at a button's centre is the button, not the composer or anything else over it. */
async function reachable(page: Page, button: Locator) {
  await expect(button).toBeInViewport({ ratio: 1 });
  const box = await button.boundingBox();
  if (!box) throw new Error("The button isn't laid out");
  const hit = await page.evaluate(
    ([x, y]) => document.elementFromPoint(x!, y!)?.closest("button")?.textContent ?? null,
    [box.x + box.width / 2, box.y + box.height / 2],
  );
  expect(hit).toBe(await button.textContent());
}

for (const width of [390, 1440])
  test(`at ${width}px an approval's Allow once and Deny show without scrolling, its details folded away`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
    await page.goto("/t/thread-ux-pending-full-access");
    const card = page
      .getByRole("region", { name: "Waiting for you" })
      .getByRole("article", { name: /bun install --frozen-lockfile/ });
    await expect(card).toBeVisible();
    await settled(page);

    // The command shows once; the review's facts wait behind Details.
    await expect(card.getByText("bun install --frozen-lockfile", { exact: true })).toHaveCount(1);
    await expect(card.getByRole("region", { name: "ace's review" })).toHaveCount(0);
    for (const name of ["Allow once", "Deny"])
      await reachable(page, card.getByRole("button", { name, exact: true }));

    // Opened, the details sit below the buttons: the decision stays where it was.
    await card.getByRole("button", { name: "Details" }).click();
    await expect(card.getByRole("region", { name: "ace's review" })).toBeVisible();
    await reachable(page, card.getByRole("button", { name: "Allow once", exact: true }));
  });

test("an app request names the app and its buttons fit at 390px", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.addInitScript(() => Object.assign(globalThis, { aceFakeWorld: "computer-use" }));
  await page.goto("/t/thread-dedupe");
  const card = page.getByRole("article", { name: "Let an agent use Notes" });
  await expect(card).toBeVisible({ timeout: 15_000 });
  await settled(page);
  await expect(card.getByText("com.apple.Notes")).toHaveCount(0);
  for (const name of ["Allow once", "Always allow", "Deny"])
    await reachable(page, card.getByRole("button", { name, exact: true }));
});
