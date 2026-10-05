import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
import { harness } from "@/test/harness.tsx";

const minute = 60_000;
const hour = 60 * minute;
const day = 24 * hour;
type App = ReturnType<typeof harness>;

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

test("headroom names each provider's account with the most room and when the next one frees up", async () => {
  const app = harness();
  report(app, "claude-personal", { five_hour: [62, 2 * hour], seven_day: [41, 4 * day] });
  report(app, "claude-work", { five_hour: [23, 3 * hour], seven_day: [57, 2 * day] });
  report(app, "codex-personal", { five_hour: [38, 3 * hour], seven_day: [22, 5 * day] });
  report(app, "codex-team", { five_hour: [100, 87 * minute] }, "exhausted");
  await app.open("/more/accounts");
  const work = await screen.findByRole("article", { name: "Claude Code Work" });

  const headroom = screen.getByRole("list", { name: "Headroom now" });
  const rows = within(headroom)
    .getAllByRole("listitem")
    .map((row) => row.textContent);
  expect(rows[0]).toBe("Claude Code2 of 2 accounts can work · Most room: Work, 43% of Weekly left");
  expect(rows[1]).toMatch(
    /^Codex1 of 2 accounts can work · Most room: Personal, 62% of 5-hour left · Team resets \d\d:\d\d · in 1h 2\dm$/,
  );
  // OpenCode and Cursor report no windows: nothing to compare.
  expect(rows.some((row) => row?.startsWith("OpenCode"))).toBe(false);

  // Each ring says how long until its window resets.
  expect(
    within(work).getByRole("meter", { name: "Weekly window" }).getAttribute("aria-valuetext"),
  ).toMatch(/^57% used, resets \w+ · in 2d$/);
});

/** A table row's first two cells: who and which provider. */
const cells = (row: HTMLElement) =>
  within(row)
    .getAllByRole("cell")
    .slice(0, 2)
    .map((cell) => cell.textContent);

test("usage by account lists each account's tokens under its name", async () => {
  await harness().open("/more/accounts");
  await userEvent.click(await screen.findByRole("button", { name: "By account" }));

  const table = await screen.findByRole("table", { name: "Usage by account" });
  const rows = await within(table).findAllByRole("row");
  // Busiest first; an account ace doesn't list keeps its id.
  expect(rows.slice(1).map(cells)).toEqual([
    ["Personal", "Claude Code"],
    ["Personal", "Codex"],
    ["Work", "Claude Code"],
    ["opencode-api", "OpenCode"],
  ]);
});
