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
  test(`at ${width}px an approval's Allow once and Deny show without scrolling`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
    await page.goto("/t/thread-ux-pending-full-access");
    const card = page
      .getByRole("region", { name: "Waiting for you" })
      .getByRole("article", { name: /bun install --frozen-lockfile/ });
    await expect(card).toBeVisible();
    await settled(page);

    // The command shows once.
    await expect(card.getByText("bun install --frozen-lockfile", { exact: true })).toHaveCount(1);
    for (const name of ["Allow once", "Deny"])
      await reachable(page, card.getByRole("button", { name, exact: true }));
  });
