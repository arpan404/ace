import type { UsageSource } from "@ace/fake-daemon";
import type { FakeDaemon } from "@ace/fake-daemon";
import { configure, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { harness } from "@/test/harness.tsx";

configure({ asyncUtilTimeout: 10_000 });
vi.setConfig({ testTimeout: 30_000 });

const minute = 60_000;
const hour = 60 * minute;
const day = 24 * hour;
/** Later than any real clock the suite runs at; the page's minute clock never runs backwards. */
const now = Date.parse("2036-10-01T15:00:00Z");
beforeEach(() => vi.useFakeTimers({ toFake: ["Date"], now }));
afterEach(() => vi.useRealTimers());

/** What one account's provider reports: share USED per window and when each resets. */
function report(
  daemon: FakeDaemon,
  id: string,
  windows: Record<string, [used: number, resetsIn: number, minutes?: number]>,
  banked?: number,
) {
  const account = daemon.services.accounts.find((entry) => entry.id === id);
  if (!account) throw new Error(`no account ${id}`);
  account.quota.windows = Object.fromEntries(
    Object.entries(windows).map(([name, [usedPercent, resetsIn, minutes]]) => [
      name,
      {
        usedPercent,
        resetsAt: now + resetsIn,
        ...(minutes ? { windowDurationMins: minutes } : {}),
      },
    ]),
  );
  if (banked === undefined) delete account.quota.resetCredits;
  else account.quota.resetCredits = { available: banked, nextExpiresAt: null };
}

/** Steady sources: 80K input and 20K output tokens a day, so 100K tokens a day each. */
const source = (provider: string, account: string, model: string, price: number | null) =>
  ({
    provider,
    account,
    model,
    daily: 80_000,
    steady: true,
    apiUsdPerMillion: price,
    billing: "subscription",
    threads: [`thread-${provider}`],
  }) satisfies UsageSource;

/** One account's block on Limits: "Codex · Personal · <environment>". */
const account = (provider: string, name: string) =>
  screen.findByRole("article", { name: new RegExp(`^${provider} · ${name} · `) });
/** One of an account's windows, as a meter of what is left. */
const meter = async (provider: string, name: string, window: string) =>
  within(await account(provider, name)).getByRole("meter", { name: window });

/** A figure in Totals, by its label. */
function stat(label: string) {
  const term = screen.getByText(label, { selector: "dt" });
  return term.nextElementSibling?.textContent;
}

async function show(view: "Cost" | "Tokens" | "Limits") {
  await userEvent.click(
    within(await screen.findByRole("group", { name: "View" })).getByRole("button", { name: view }),
  );
}

test("limits say what is left, from the share the provider reports used", async () => {
  const app = harness();
  report(app.daemon, "claude-personal", { five_hour: [62, 2 * hour] });
  report(app.daemon, "claude-work", { five_hour: [100, 3 * hour] });
  await app.open("/usage");

  const personal = await meter("Claude Code", "Personal", "5-hour");
  expect(personal.getAttribute("aria-valuenow")).toBe("38");
  expect(personal.getAttribute("aria-valuetext")).toBe("38% left, resets in 2h");
  expect((await account("Claude Code", "Personal")).textContent).toContain("38% left");
  // An account with nothing left says when it is back.
  const work = await account("Claude Code", "Work");
  expect(work.textContent).toContain("0% left");
  expect(work.textContent).toContain("Back in 3h");
  expect(document.body.textContent).not.toMatch(/\d+% used/);
});

test("each window's reset reads as a countdown to the minute, then in days", async () => {
  const app = harness();
  report(app.daemon, "codex-personal", {
    five_hour: [10, 2 * hour + 14 * minute],
    seven_day: [10, 6 * day + 12 * hour],
  });
  await app.open("/usage");
  const personal = await account("Codex", "Personal");
  expect(personal.textContent).toContain("Resets in 2h 14m");
  expect(personal.textContent).toContain("Resets in 6d 12h");
});

test("banked resets show under an account only when its provider reports some", async () => {
  const app = harness();
  report(app.daemon, "codex-personal", { five_hour: [40, hour] }, 3);
  report(app.daemon, "codex-team", { five_hour: [100, hour] }, 0);
  report(app.daemon, "claude-personal", { five_hour: [40, hour] });
  await app.open("/usage");

  expect((await account("Codex", "Personal")).textContent).toContain("3 banked resets");
  expect((await account("Codex", "Team")).textContent).not.toContain("banked");
  expect((await account("Claude Code", "Personal")).textContent).not.toContain("banked");
});

test("each account is listed once, with each of its windows beneath it", async () => {
  const app = harness();
  report(app.daemon, "codex-personal", { five_hour: [30, hour], seven_day: [10, day] });
  report(app.daemon, "codex-team", { five_hour: [90, hour] });
  await app.open("/usage");

  const codex = await screen.findByRole("region", { name: "Codex" });
  expect(
    within(codex)
      .getAllByRole("article")
      .map((each) => each.getAttribute("aria-label")?.split(" · ")[1]),
  ).toEqual(["Personal", "Team"]);
  const personal = within(await account("Codex", "Personal"));
  expect(personal.getAllByRole("meter").map((each) => each.getAttribute("aria-label"))).toEqual([
    "5-hour",
    "Weekly",
  ]);
  const team = within(await account("Codex", "Team"));
  expect(team.getAllByRole("meter").map((each) => each.getAttribute("aria-label"))).toEqual([
    "5-hour",
  ]);
});

test("a window used faster than it runs says it is ahead of pace", async () => {
  const app = harness();
  // Four of five hours left with half used: running out early. A week barely used: room to spare.
  report(app.daemon, "codex-personal", {
    five_hour: [50, 4 * hour, 300],
    seven_day: [5, 4 * day, 10080],
  });
  await app.open("/usage");
  const personal = await account("Codex", "Personal");
  expect(within(personal).getByText("Ahead of pace")).toBeTruthy();
  expect(within(personal).getByText("Under pace")).toBeTruthy();
});

test("the range and the provider filter change the totals", async () => {
  const app = harness();
  app.daemon.services.usage.sources = [
    source("claude", "claude-personal", "claude-opus-4-6", 15),
    source("codex", "codex-personal", "gpt-5.3-codex", 5),
  ];
  await app.open("/usage");
  await show("Tokens");
  await userEvent.click(await screen.findByRole("button", { name: "7 days" }));
  await waitFor(() => expect(stat("Processed tokens")).toBe("1.4M"));

  await userEvent.click(screen.getByRole("button", { name: "30 days" }));
  await waitFor(() => expect(stat("Processed tokens")).toBe("6.0M"));

  await userEvent.click(screen.getByRole("button", { name: "Provider: All providers" }));
  await userEvent.click(await screen.findByRole("menuitemradio", { name: "Codex" }));
  await waitFor(() => expect(stat("Processed tokens")).toBe("3.0M"));
  expect(screen.queryByRole("listitem", { name: "Claude Code" })).toBeNull();
});

test("a model without a price reads Unpriced and folds away in money, never a $0.00 cost", async () => {
  const app = harness();
  app.daemon.services.usage.sources = [
    source("codex", "codex-personal", "gpt-5.3-codex", 5),
    source("opencode", "opencode-api", "opencode/kimi-k2", null),
  ];
  await app.open("/usage");
  await show("Tokens");
  const table = await screen.findByRole("table", { name: /Tokens by model/ });
  const kimi = within(table).getByText("Kimi K2").closest("tr");
  expect(kimi && within(kimi).getByText("Unpriced")).toBeTruthy();

  await show("Cost");
  expect(await screen.findByRole("table", { name: /Cost by model/ })).toBeTruthy();
  expect(
    within(screen.getByRole("listitem", { name: "OpenCode" })).getByText("Unpriced"),
  ).toBeTruthy();
  const costs = screen.getByRole("table", { name: /Cost by model/ });
  expect(within(costs).queryByText("Kimi K2")).toBeNull();
  await userEvent.click(screen.getByRole("button", { name: /Show 1 unpriced model/ }));
  expect(within(costs).getByText("Kimi K2")).toBeTruthy();
  expect(document.body.textContent).not.toContain("Unavailable");
});

test("the environment filter shows every connected environment, or just the one chosen", async () => {
  const app = harness({ machines: [{ hostId: "build-server", name: "Build server" }] });
  const server = app.machines.get("build-server");
  if (!server) throw new Error("no build server");
  report(app.daemon, "codex-personal", { five_hour: [20, hour] });
  report(app.daemon, "codex-team", { five_hour: [20, hour] });
  report(server, "codex-team", { five_hour: [50, hour] });
  server.services.accounts = server.services.accounts.filter((each) => each.id === "codex-team");
  app.daemon.services.usage.sources = [source("codex", "codex-personal", "gpt-5.3-codex", 5)];
  server.services.usage.sources = [source("codex", "codex-team", "gpt-5.3-codex", 5)];
  await app.open("/usage");

  // Both environments' Codex accounts, each named with where it runs.
  expect(await screen.findByRole("article", { name: "Codex · Team · Build server" })).toBeTruthy();
  expect(await screen.findByRole("article", { name: "Codex · Personal · This Mac" })).toBeTruthy();

  await userEvent.click(screen.getByRole("button", { name: "Environment: All environments" }));
  await userEvent.click(await screen.findByRole("menuitemradio", { name: "Build server" }));
  await waitFor(() =>
    expect(screen.queryByRole("article", { name: /^Codex · Personal/ })).toBeNull(),
  );
  expect((await meter("Codex", "Team", "5-hour")).getAttribute("aria-valuenow")).toBe("50");

  await show("Tokens");
  await userEvent.click(await screen.findByRole("button", { name: "7 days" }));
  await waitFor(() => expect(stat("Processed tokens")).toBe("700K"));
  await userEvent.click(screen.getByRole("button", { name: "Environment: Build server" }));
  await userEvent.click(await screen.findByRole("menuitemradio", { name: "All environments" }));
  await waitFor(() => expect(stat("Processed tokens")).toBe("1.4M"));
});
