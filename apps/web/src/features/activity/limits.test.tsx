import { teamAtLimit } from "@ace/fake-daemon";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, test } from "vitest";
import { harness } from "@/test/harness.tsx";

beforeEach(() => localStorage.clear());

const minute = 60_000;
const hour = 60 * minute;
type App = ReturnType<typeof harness>;

const toasts = () => screen.getByRole("region", { name: "Notifications" });
/** Usage & accounts reads quota again; every screen showing it gets the new reading. */
const refresh = () => userEvent.click(screen.getByRole("button", { name: "Refresh" }));

function report(
  app: App,
  id: string,
  windows: Record<string, [used: number, resetsIn: number]>,
  availability: "available" | "near_limit" | "exhausted" = "available",
) {
  const account = app.daemon.services.accounts.find((entry) => entry.id === id);
  if (!account) throw new Error(`no account ${id}`);
  account.availability = availability;
  account.quota.windows = Object.fromEntries(
    Object.entries(windows).map(([window, [usedPercent, resetsIn]]) => [
      window,
      { usedPercent, resetsAt: Date.now() + resetsIn },
    ]),
  );
}

test("Activity lists threads paused at a usage limit by account and moves them to one with room", async () => {
  const app = harness();
  report(app, "codex-team", { five_hour: [100, 87 * minute] }, "exhausted");
  report(app, "codex-personal", { five_hour: [38, 3 * hour] });
  for (const scenario of teamAtLimit()) app.play(scenario).runThrough("limited");
  await app.open("/activity");

  const team = await screen.findByRole("article", { name: "Codex · Team" });
  expect(within(team).getByText(/^3 threads paused · Resets \d\d:\d\d · in 1h 2\dm$/)).toBeTruthy();
  expect(
    within(team)
      .getAllByRole("link")
      .map((link) => link.textContent),
  ).toEqual([
    "Remove the legacy feature-flag reader",
    "Rank workspace search by recent edits",
    "Split the CI matrix by package",
  ]);

  await userEvent.click(within(team).getByRole("button", { name: "Move to Codex · Personal" }));

  expect(await within(toasts()).findByText("Moved 3 threads to Codex · Personal")).toBeTruthy();
  await waitFor(() =>
    expect(screen.queryByRole("heading", { name: "Paused at a usage limit" })).toBeNull(),
  );
});

test("toasts say when an account nears its limit, reaches it and can work again", async () => {
  const app = harness();
  report(app, "claude-work", { five_hour: [60, 2 * hour] });
  await app.open("/more/accounts");
  await screen.findByRole("article", { name: "Claude Code Work" });

  report(app, "claude-work", { five_hour: [92, 2 * hour] }, "near_limit");
  await refresh();
  expect(
    await within(toasts()).findByText("Claude Code · Work is near its usage limit"),
  ).toBeTruthy();
  expect(within(toasts()).getByText(/^92% of the 5-hour window used\. Resets/)).toBeTruthy();

  report(app, "claude-work", { five_hour: [100, 2 * hour] }, "exhausted");
  await refresh();
  expect(
    await within(toasts()).findByText("Claude Code · Work reached its usage limit"),
  ).toBeTruthy();

  report(app, "claude-work", { five_hour: [4, 5 * hour] });
  await refresh();
  expect(await within(toasts()).findByText("Claude Code · Work can work again")).toBeTruthy();
});

test("with limit toasts turned off, an account reaching its limit stays quiet", async () => {
  localStorage.setItem("ace.notifications.toasts", JSON.stringify({ limits: false }));
  const app = harness();
  report(app, "claude-work", { five_hour: [60, 2 * hour] });
  await app.open("/more/accounts");
  const work = await screen.findByRole("article", { name: "Claude Code Work" });

  report(app, "claude-work", { five_hour: [100, 2 * hour] }, "exhausted");
  await userEvent.click(screen.getByRole("button", { name: "Refresh" }));
  // The page has the new reading, and no toast came with it.
  expect(await within(work).findByText("Limit reached")).toBeTruthy();
  expect(screen.queryByText("Claude Code · Work reached its usage limit")).toBeNull();
});
