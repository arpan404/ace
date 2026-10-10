import { expect, test, type Page } from "@playwright/test";
import { openTurns } from "../thread-header.ts";

/**
 * Long-thread journeys against the fake daemon's five-day migration (24 turns of 70 progress
 * notes each; the fake snapshot holds the newest 40 items): the turn timeline and jumping into
 * history, the gap back to live and following the live end, ⌘F search without an automatic summary panel.
 */

const path = "/t/thread-multi-day";
const mod = "ControlOrMeta";
const ask = (n: number) => `Migrate checkpoint ${n}, inspect files and report failures.`;

/**
 * Open the five-day thread. `live` makes the agent keep writing to it (a note every 250 ms),
 * staged in the fake daemon before the app's first request.
 */
async function openThread(page: Page, options: { live?: boolean } = {}) {
  if (options.live)
    await page.addInitScript(() => {
      Object.assign(globalThis, {
        aceFakeSetup: (daemon: { apply(id: string, facts: unknown[]): void }) => {
          let n = 0;
          daemon.apply("thread-multi-day", [
            { type: "turn.started", agent: "root", nativeTurnId: "turn-live", trigger: "user" },
          ]);
          setInterval(() => {
            n++;
            daemon.apply("thread-multi-day", [
              {
                type: "item.upsert",
                agent: "root",
                item: `live-${n}`,
                draft: {
                  type: "message",
                  role: "assistant",
                  complete: true,
                  parts: [{ type: "text", text: `Live finding ${n}: the replay window held.` }],
                },
              },
            ]);
          }, 250);
        },
      });
    });
  await page.goto(path);
  const feed = page.locator("[data-thread-column]").getByRole("feed", { name: "Transcript" });
  await feed.waitFor();
  await expect(page.getByRole("region", { name: "While you were away" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Summarise", exact: true })).toHaveCount(0);
  return { feed };
}

test("the timeline jumps across days and Jump to live comes back", async ({ page }) => {
  const { feed } = await openThread(page);
  await expect(feed.getByText(ask(3))).toHaveCount(0);

  await page.keyboard.press(`Alt+${mod}+g`);
  const turns = page.getByRole("listbox", { name: "Turns of this thread" });
  await expect(turns).toBeFocused();
  // The list knows how many turns there are once the index answers.
  await expect(turns.getByRole("option", { name: /^Turn 24: / })).toBeVisible();
  await page.keyboard.press("Home");
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("ArrowDown");
  await expect(turns.getByRole("option", { name: /^Turn 3: / })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await page.keyboard.press("Enter");

  const jumped = page.getByRole("status", { name: "Jumped" });
  await expect(jumped).toContainText("Jumped to turn 3");
  await expect(jumped).toContainText("of 24");
  await expect(feed.getByText(ask(3))).toBeInViewport();
  // Older turns above the jump fold to one line with their digest.
  await expect(feed.getByRole("button", { name: `Turn 2: ${ask(2)} Show the turn` })).toBeVisible();
  await page.keyboard.press("Escape");

  await page
    .getByRole("button", { name: /^Jump to live/ })
    .first()
    .click();
  await expect(jumped).toHaveCount(0);
  await expect(
    feed.getByText("Checkpoint 24 completed. Migration paths validated; all commands passed."),
  ).toBeInViewport();
});

test("scrolling down a jumped window reads on to the live end without a gap", async ({ page }) => {
  const { feed } = await openThread(page);
  const turns = await openTurns(page);
  await expect(turns.getByRole("option", { name: /^Turn 24: / })).toBeVisible();
  await page.keyboard.press("End");
  for (let n = 0; n < 3; n++) await page.keyboard.press("ArrowUp");
  await page.keyboard.press("Enter");
  await expect(page.getByRole("status", { name: "Jumped" })).toContainText("Jumped to turn 21");
  await page.keyboard.press("Escape");

  // The window slides on as the reader scrolls; once it reaches the tail it joins it and the
  // reader ends up following the live end.
  await feed.hover();
  await expect(async () => {
    await page.mouse.wheel(0, 6_000);
    await expect(page.getByRole("status", { name: "Jumped" })).toHaveCount(0, { timeout: 600 });
  }).toPass({ timeout: 30_000 });
  await expect(
    feed.getByText("Checkpoint 24 completed. Migration paths validated; all commands passed."),
  ).toBeInViewport();
  await expect(page.getByRole("button", { name: /^Jump to live/ })).toHaveCount(0);
});

test("the live end is followed until the reader scrolls up, then Jump to live counts what's new", async ({
  page,
}) => {
  const { feed } = await openThread(page, { live: true });
  // Following: each new note scrolls into view.
  await expect(feed.getByText(/^Live finding 4:/)).toBeInViewport();
  await expect(feed.getByText(/^Live finding 8:/)).toBeInViewport();

  await feed.hover();
  await page.mouse.wheel(0, -1_500);
  const pill = page.getByRole("button", { name: /^Jump to live, \d+ new$/ });
  await expect(pill).toBeVisible();
  await expect(pill).toContainText("Following paused");
  const later = Number((await pill.getAttribute("aria-label"))?.match(/(\d+) new/)?.[1]);
  await expect(async () => {
    const now = Number((await pill.getAttribute("aria-label"))?.match(/(\d+) new/)?.[1]);
    expect(now).toBeGreaterThan(later);
  }).toPass();

  await pill.click();
  await expect(pill).toHaveCount(0);
  const newest = feed.getByText(/^Live finding \d+:/).last();
  await expect(newest).toBeInViewport();
});

test("⌘F finds words across the thread and steps through the hits", async ({ page }) => {
  await openThread(page);
  await page.keyboard.press(`${mod}+f`);
  const bar = page.getByRole("search", { name: "Search this thread" });
  await expect(bar.getByRole("textbox", { name: "Search this thread" })).toBeFocused();
  await page.keyboard.type("validation failed");
  // Checkpoints 7, 14 and 21 failed their validation.
  await expect(bar.getByText("3 results")).toBeVisible();
  await expect(bar.getByRole("option")).toHaveCount(3);
  await expect(bar.getByRole("option").first().locator("mark")).toHaveText("validation failed");

  await page.keyboard.press("Enter");
  const jumped = page.getByRole("status", { name: "Jumped" });
  await expect(jumped).toContainText("Jumped to turn 7");
  await expect(bar.getByText("1 of 3 results")).toBeVisible();
  // The words are marked in the transcript too.
  await expect
    .poll(() => page.evaluate(() => CSS.highlights.get("ace-find")?.size ?? 0))
    .toBeGreaterThan(0);

  await page.keyboard.press("Enter");
  await expect(jumped).toContainText("Jumped to turn 14");
  await page.keyboard.press("Shift+Enter");
  await expect(jumped).toContainText("Jumped to turn 7");

  await bar.getByRole("button", { name: "Messages" }).click();
  await expect(bar.getByText("Nothing in this thread matches.")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(bar).toHaveCount(0);
});

test("a returning reader sees the transcript without an automatic summary", async ({ page }) => {
  const { feed } = await openThread(page);
  await expect(
    feed.getByText("Checkpoint 24 completed. Migration paths validated; all commands passed."),
  ).toBeInViewport();
  await expect(page.getByRole("combobox", { name: "Message", exact: true })).toBeVisible();
});

test("⌥⌘↑ walks back turn by turn into history", async ({ page }) => {
  const { feed } = await openThread(page);
  await feed.hover();
  for (let press = 0; press < 4; press++) await page.keyboard.press(`Alt+${mod}+ArrowUp`);
  await expect(page.getByRole("status", { name: "Jumped" })).toContainText(/Jumped to turn 2[0-3]/);
  await page.keyboard.press(`Alt+${mod}+ArrowDown`);
  await expect(page.getByRole("status", { name: "Jumped" })).toBeVisible();
});
