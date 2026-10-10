import { configure, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { harness } from "@/test/harness.tsx";

configure({ asyncUtilTimeout: 10_000 });

const minute = 60_000;
const hour = 60 * minute;
const day = 24 * hour;
/**
 * The wall clock, held still so countdowns and usage days read exactly. Later than any real clock
 * the suite runs at, since the page's shared minute clock never runs backwards.
 */
const now = Date.parse("2036-10-01T15:00:00Z");

vi.setConfig({ testTimeout: 30_000 });
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

test("usage puts limited accounts first and exposes each provider reset time", async () => {
  const app = harness();
  report(app, "claude-personal", { five_hour: [62, 2 * hour], seven_day: [41, 4 * day] });
  report(app, "claude-work", { five_hour: [23, 3 * hour], seven_day: [57, 2 * day] });
  report(app, "codex-personal", { five_hour: [38, 3 * hour], seven_day: [22, 5 * day] });
  report(app, "codex-team", { five_hour: [100, 87 * minute] });
  await app.open("/accounts");
  const work = await screen.findByRole("article", { name: "Claude Code Work" });

  expect(
    within(await screen.findByRole("region", { name: "Closest to a limit" })).getByRole("article", {
      name: "Codex Team",
    }),
  ).toBeTruthy();
  expect(
    within(await screen.findByRole("region", { name: "Everything else" })).getByRole("article", {
      name: "Claude Code Work",
    }),
  ).toBeTruthy();
  expect(screen.queryByRole("list", { name: "Headroom now" })).toBeNull();

  // Each ring says how long until its window resets.
  expect(
    within(work).getByRole("meter", { name: "Weekly window" }).getAttribute("aria-valuetext"),
  ).toMatch(/^57% used, Resets \w+ · in 2d$/);
});

test("usage by account lists each account's tokens under its name", async () => {
  await harness().open("/accounts");
  await userEvent.click(await screen.findByRole("button", { name: "By account" }));

  const table = await screen.findByRole("table", { name: "Usage by account" });
  const rows = await within(table).findAllByRole("row");
  const expected = [
    ["Claude Code", "Personal", "50.8M"],
    ["Codex", "Personal", "37.0M"],
    ["Claude Code", "Work", "31.7M"],
    ["OpenCode", "OpenRouter API", "9.4M"],
    ["Pi", "API key", "3.0M"],
  ] as const;
  expect(rows).toHaveLength(expected.length + 1);
  for (const [index, [provider, account, tokens]] of expected.entries()) {
    const row = rows[index + 1];
    if (!row) throw new Error("Missing usage account row");
    const shown = within(row);
    expect(shown.getByRole("img", { name: provider })).toBeTruthy();
    expect(shown.getByRole("img", { name: `${account} account` })).toBeTruthy();
    expect(shown.getByText(`${provider} · ${account}`, { exact: true })).toBeTruthy();
    expect(shown.getByRole("cell", { name: tokens })).toBeTruthy();
  }
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
