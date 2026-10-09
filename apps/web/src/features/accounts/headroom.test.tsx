import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { harness } from "@/test/harness.tsx";

const minute = 60_000;
const hour = 60 * minute;
const day = 24 * hour;
/**
 * The wall clock, held still so countdowns and usage days read exactly. Later than any real clock
 * the suite runs at, since the page's shared minute clock never runs backwards.
 */
const now = Date.parse("2036-10-01T15:00:00Z");

beforeEach(() => vi.useFakeTimers({ toFake: ["Date"], now }));
afterEach(() => vi.useRealTimers());

type App = ReturnType<typeof harness>;

/** What the daemon reports for one account's windows: share used and when each resets. */
function report(app: App, id: string, windows: Record<string, [used: number, resetsIn: number]>) {
  const account = app.daemon.services.accounts.find((entry) => entry.id === id);
  if (!account) throw new Error(`no account ${id}`);
  account.quota.windows = Object.fromEntries(
    Object.entries(windows).map(([window, [usedPercent, resetsIn]]) => [
      window,
      { usedPercent, resetsAt: now + resetsIn },
    ]),
  );
}

test("headroom names each provider's account with the most room and when the next one frees up", async () => {
  const app = harness();
  report(app, "claude-personal", { five_hour: [62, 2 * hour], seven_day: [41, 4 * day] });
  report(app, "claude-work", { five_hour: [23, 3 * hour], seven_day: [57, 2 * day] });
  report(app, "codex-personal", { five_hour: [38, 3 * hour], seven_day: [22, 5 * day] });
  report(app, "codex-team", { five_hour: [100, 87 * minute] });
  await app.open("/accounts");
  const work = await screen.findByRole("article", { name: "Claude Code Work" });

  const headroom = screen.getByRole("list", { name: "Headroom now" });
  const rows = within(headroom)
    .getAllByRole("listitem")
    .map((row) => row.textContent);
  expect(rows[0]).toBe(
    "Claude Code3 of 3 accounts can work · 1 with no limits reported · Most room: Work, 43% of Weekly left",
  );
  expect(rows[1]).toMatch(
    /^Codex1 of 3 accounts can work · 1 with no limits reported · Most room: Personal, 62% of 5-hour left · Team resets \d{1,2}:\d\d(?: [AP]M)? · in 1h 27m$/i,
  );
  // OpenCode and Cursor report no windows: nothing to compare.
  expect(rows.find((row) => row?.startsWith("OpenCode"))).toContain("no limits reported");

  // Each ring says how long until its window resets.
  expect(
    within(work).getByRole("meter", { name: "Weekly window" }).getAttribute("aria-valuetext"),
  ).toMatch(/^57% used, Resets \w+ · in 2d$/);
});

/** A table row's cells: who, which provider, how many tokens. */
const cells = (row: HTMLElement) =>
  within(row)
    .getAllByRole("cell")
    .slice(0, 3)
    .map((cell) => cell.textContent);

test("usage by account lists each account's tokens under its name", async () => {
  await harness().open("/accounts");
  await userEvent.click(await screen.findByRole("button", { name: "By account" }));

  const table = await screen.findByRole("table", { name: "Usage by account" });
  const rows = await within(table).findAllByRole("row");
  // Busiest first; an account ace doesn't list keeps its id.
  expect(rows.slice(1).map(cells)).toEqual([
    ["Personal", "Claude Code", "50.8M"],
    ["Personal", "Codex", "37.0M"],
    ["Work", "Claude Code", "31.7M"],
    ["OpenRouter API", "OpenCode", "9.4M"],
    ["API key", "Pi", "3.0M"],
  ]);
});

test("when usage can't be read, each grouping says so with its own retry and the other stays reachable", async () => {
  const app = harness();
  app.daemon.failRequests("usage.summary");
  await app.open("/accounts");

  // Each read is tried twice before it is called failed.
  const byModel = await screen.findByText(
    "Usage by model couldn't be read.",
    {},
    { timeout: 5_000 },
  );
  expect(byModel.closest("[role=alert]")).toBeTruthy();
  // Switching grouping is still offered.
  await userEvent.click(screen.getByRole("button", { name: "By account" }));
  const failed = (
    await screen.findByText("Usage by account couldn't be read.", {}, { timeout: 5_000 })
  ).closest("[role=alert]");
  if (!(failed instanceof HTMLElement)) throw new Error("no alert");

  app.daemon.restoreRequests();
  await userEvent.click(within(failed).getByRole("button", { name: "Try again" }));
  const table = await screen.findByRole("table", { name: "Usage by account" });
  expect((await within(table).findAllByRole("row")).length).toBeGreaterThan(1);
}, 15_000);

test("a grouping cut short says how many it shows", async () => {
  const app = harness();
  const usage = app.daemon.services.usage;
  const answer = usage.report.bind(usage);
  // The daemon had more accounts than one reply carries.
  usage.report = (query, kind) => ({
    ...answer(query, kind),
    truncated: query.groupBy.includes("account"),
  });
  await app.open("/accounts");
  await userEvent.click(await screen.findByRole("button", { name: "By account" }));

  await screen.findByRole("table", { name: "Usage by account" });
  expect(
    await screen.findByText("Shows the 5 busiest accounts; the rest are left out."),
  ).toBeTruthy();
});
