import { expect, type Locator, type Page } from "@playwright/test";

/*
 * The thread header's controls as a person reaches them: the work card behind the list button
 * (git, the project's actions, Open in) and the ⋯ menu (Search this thread, Turns).
 */

/** The thread's work card, floating under the header while it is open. */
export const workCard = (page: Page): Locator =>
  page.getByRole("complementary", { name: "Work card" });

/** Open the work card from the header's list button. */
export async function openWorkCard(page: Page): Promise<Locator> {
  await page
    .getByRole("banner")
    .getByRole("button", { name: /^Work card/ })
    .click();
  const card = workCard(page);
  await expect(card).toBeVisible();
  return card;
}

/** Run one of the project's scripts from the work card's Actions, by its command. */
export async function runAction(page: Page, command: string): Promise<void> {
  const card = await openWorkCard(page);
  await card.getByRole("button", { name: "Project actions" }).click();
  await page.getByRole("menuitem", { name: `Run ${command}` }).click();
}

/** Pick an item of the header's ⋯ menu. */
export async function chooseFromThreadMenu(page: Page, item: RegExp): Promise<void> {
  await page.getByRole("banner").getByRole("button", { name: "More actions" }).click();
  await page.getByRole("menuitem", { name: item }).click();
}

/**
 * Open the thread's turns from the ⋯ menu and put the keyboard on their list, as a person
 * would before reading through them with the arrow keys.
 */
export async function openTurns(page: Page): Promise<Locator> {
  await chooseFromThreadMenu(page, /^Turns/);
  const turns = page.getByRole("listbox", { name: "Turns of this thread" });
  await expect(turns).toBeVisible();
  // The menu hands focus back as it closes; the list takes it once the menu has gone.
  await expect(page.getByRole("menu")).toHaveCount(0);
  await turns.focus();
  return turns;
}
