import { mkdirSync, readFileSync } from "node:fs";
import { expect, test, type Page } from "@playwright/test";
import {
  daemonPort,
  daemonTokenPath,
  deckAskMarker,
  deckQuestion,
} from "../src/real-daemon-config.ts";

/**
 * A deck on a real apps/daemon (src/real-daemon.ts): the native conductor plans, deals and
 * reviews two cards on real engine threads, with the scripted provider returning each role's
 * artifact and doing a worker's Git work in its own worktree. No provider CLI runs. Each run
 * starts its own deck, so the journey can run again against the same daemon.
 */
const shots = process.env.ACE_SHOTS_DIR ?? "/tmp/aceshots-web";

async function connect(page: Page, path: string) {
  const token = readFileSync(daemonTokenPath, "utf8").trim();
  const daemon = encodeURIComponent(`ws://127.0.0.1:${daemonPort}/`);
  await page.goto(`${path}#token=${token}&daemon=${daemon}`);
  await expect(page.getByRole("status", { name: "Daemon: Connected" })).toBeAttached();
}

/**
 * A capture of the live deck, Dark then Light, for comparing against the fake's screens. The
 * theme applies on load, so each capture reloads the page; the app reconnects by itself.
 */
async function shoot(page: Page, name: string, ready: (page: Page) => Promise<void>) {
  mkdirSync(shots, { recursive: true });
  for (const theme of ["dark", "light"] as const) {
    await page.evaluate(
      (id) => localStorage.setItem("ace.appearance", JSON.stringify({ theme: id })),
      theme,
    );
    await page.reload();
    await expect(page.getByRole("status", { name: "Daemon: Connected" })).toBeAttached();
    await ready(page);
    await page.waitForTimeout(600);
    await page.screenshot({ path: `${shots}/real-${name}-${theme}.png` });
  }
}

test("a deck starts on the real daemon, waits on its plan and a worker's question, and merges", async ({
  page,
}) => {
  test.setTimeout(120_000);
  const run = Date.now().toString(36);
  const goal = `Add a health note ${deckAskMarker} and document it in the README (${run}).`;
  await connect(page, "/deck/new");

  // The form offers what this daemon can run: its CLIs' own logins, no accounts to pick.
  const form = page.getByRole("form", { name: "New deck" });
  await expect(form.getByText(/Workers run .+ on Claude Code · default login/)).toBeVisible();
  await form.getByLabel("Goal").fill(goal);
  await form.getByRole("radio", { name: /Merge when every review passes/ }).click();
  await form.getByRole("button", { name: /Start deck/ }).click();

  // The planner works on its own thread, then the plan waits for approval.
  await expect(page.getByRole("heading", { level: 1, name: /^Add a health note/ })).toBeVisible();
  const planGate = page.getByRole("region", { name: "Deck plan needs your approval" });
  await expect(planGate).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText(/^Started (just now|\d+m ago)/)).toBeVisible();
  await expect(page.getByRole("button", { name: /Health note/ }).first()).toContainText("Planned");
  await shoot(page, "deck-plan-gate", (shown) =>
    expect(shown.getByRole("region", { name: "Deck plan needs your approval" })).toBeVisible(),
  );
  await planGate.getByRole("button", { name: "Approve plan" }).click();

  // The first card's worker asks before it works: a provider gate, on the deck and in Activity.
  const asking = page.getByRole("region", { name: "Health note needs your answer" });
  await expect(asking).toBeVisible({ timeout: 30_000 });
  await expect(asking.getByText(deckQuestion)).toBeVisible();
  const deck = new URL(page.url()).pathname;
  await shoot(page, "deck-question", (shown) =>
    expect(
      shown.getByRole("region", { name: "Health note needs your answer" }).getByText(deckQuestion),
    ).toBeVisible(),
  );
  await page
    .getByRole("navigation", { name: "Views" })
    .getByRole("link", { name: /^Activity/ })
    .click();
  const card = page.getByRole("article", { name: deckQuestion });
  await expect(card).toBeVisible();
  await expect(card).toContainText(/Add a health note/);
  await card.getByRole("button", { name: /Yes, at the root/ }).click();
  await expect(card).toHaveCount(0);

  // Back on the deck: the cards work, pass review and merge, and the deck finishes.
  await page.goto(deck);
  await expect(page.getByRole("status", { name: "Daemon: Connected" })).toBeAttached();
  await expect(asking).toHaveCount(0);
  await expect(page.getByRole("button", { name: /Health note/ }).first()).toContainText(
    /Working|In review|Merging|Merged/,
  );
  await expect(page.getByRole("list", { name: "Deck progress" })).toContainText("Merged", {
    timeout: 60_000,
  });
  const decks = page.getByRole("navigation", { name: "Decks" });
  await expect(
    decks.getByRole("region", { name: "Finished" }).getByText(/^Add a health note/),
  ).toBeVisible();

  // Every lane ran as a real thread; the merged card still opens its worker's.
  await page.getByRole("button", { name: /^Health note/ }).click();
  const lane = page.getByRole("region", { name: "Lane: Health note" });
  await expect(lane.getByRole("listitem", { name: /^Worker/ })).toBeVisible();
  await expect(lane.getByRole("listitem", { name: /^Reviewer/ })).toBeVisible();
  await shoot(page, "deck-done", (shown) =>
    expect(shown.getByRole("region", { name: "Lane: Health note" })).toBeVisible(),
  );
  await lane.getByRole("link", { name: "Open the worker thread" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Deck worker: health" })).toBeVisible();
});
