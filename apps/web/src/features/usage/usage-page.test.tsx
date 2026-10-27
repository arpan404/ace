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
const accountBlock = (provider: string, name: string) =>
  screen.findByRole("article", { name: new RegExp(`^${provider} · ${name} · `) });
/** One of an account's windows, as a meter of what is left. */
const meter = async (provider: string, name: string, window: string) =>
  within(await accountBlock(provider, name)).getByRole("meter", { name: window });

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

  const personal = await meter("Claude Code", "Personal", "Session (5h)");
  expect(personal.getAttribute("aria-valuenow")).toBe("38");
  expect(personal.getAttribute("aria-valuetext")).toBe("38% left, resets in 2h");
  expect((await accountBlock("Claude Code", "Personal")).textContent).toContain("38% left");
  // An account with nothing left says when it is back.
  const work = await accountBlock("Claude Code", "Work");
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
  const personal = await accountBlock("Codex", "Personal");
  expect(personal.textContent).toContain("Resets in 2h 14m");
  expect(personal.textContent).toContain("Resets in 6d 12h");
});

test("banked resets show under an account only when its provider reports some", async () => {
  const app = harness();
  report(app.daemon, "codex-personal", { five_hour: [40, hour] }, 3);
  report(app.daemon, "codex-team", { five_hour: [100, hour] }, 0);
  report(app.daemon, "claude-personal", { five_hour: [40, hour] });
  await app.open("/usage");

  expect((await accountBlock("Codex", "Personal")).textContent).toContain("3 banked resets");
  expect((await accountBlock("Codex", "Team")).textContent).not.toContain("banked");
  expect((await accountBlock("Claude Code", "Personal")).textContent).not.toContain("banked");
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
  const personal = within(await accountBlock("Codex", "Personal"));
  expect(personal.getAllByRole("meter").map((each) => each.getAttribute("aria-label"))).toEqual([
    "Session (5h)",
    "Weekly",
  ]);
  const team = within(await accountBlock("Codex", "Team"));
  expect(team.getAllByRole("meter").map((each) => each.getAttribute("aria-label"))).toEqual([
    "Session (5h)",
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
  const personal = await accountBlock("Codex", "Personal");
  expect(within(personal).getByText("Ahead of pace")).toBeTruthy();
  expect(within(personal).getByText("Under pace")).toBeTruthy();
});

test("a window whose reset passed since its reading keeps its place and says how old it is", async () => {
  const app = harness();
  report(app.daemon, "claude-personal", { seven_day: [64, 3 * day] });
  const account = app.daemon.services.accounts.find((entry) => entry.id === "claude-personal");
  if (!account) throw new Error("no account");
  // Read three hours ago; the 5-hour window reset an hour ago and nothing has reported since.
  account.quota.windows["five_hour"] = {
    usedPercent: 91,
    resetsAt: now - hour,
    observedAt: now - 3 * hour,
  };
  await app.open("/usage");
  const personal = await accountBlock("Claude Code", "Personal");
  expect(personal.textContent).toContain("Session (5h)");
  expect(personal.textContent).toContain("Reset 1h ago");
  expect(personal.textContent).toContain("Read 3h ago");
  // No stale figure poses as current, and the live weekly reading stays.
  expect(personal.textContent).not.toContain("9% left");
  expect(
    within(personal).getByRole("meter", { name: "Weekly" }).getAttribute("aria-valuenow"),
  ).toBe("36");
});

test("Claude's Fable limit shows as its own weekly window", async () => {
  const app = harness();
  report(app.daemon, "claude-personal", {
    five_hour: [10, 2 * hour],
    seven_day: [64, 3 * day],
    seven_day_overage_included: [27, 3 * day],
  });
  await app.open("/usage");
  const personal = within(await accountBlock("Claude Code", "Personal"));
  expect(personal.getAllByRole("meter").map((each) => each.getAttribute("aria-label"))).toEqual([
    "Session (5h)",
    "Weekly",
    "Weekly · Fable",
  ]);
  expect(
    personal.getByRole("meter", { name: "Weekly · Fable" }).getAttribute("aria-valuenow"),
  ).toBe("73");
});

/** A window as a usage read records it: share used, reset in an hour, its length. */
const reading = (usedPercent: number, minutes: number, extra = {}) => ({
  usedPercent,
  resetsAt: now + hour,
  windowDurationMins: minutes,
  ...extra,
});

test("Claude and Codex show their session and weekly windows as their usage reads report them", async () => {
  const app = harness();
  const claude = app.daemon.services.accounts.find((entry) => entry.id === "claude-personal");
  const codex = app.daemon.services.accounts.find((entry) => entry.id === "codex-personal");
  if (!claude || !codex) throw new Error("fixture accounts changed");
  // Claude's `get_usage` read at startup: the account's windows and a model's own weekly limit.
  claude.quota.windows = {
    five_hour: reading(32, 300),
    seven_day: reading(97, 10080),
    "seven_day_model:Fable": reading(6, 10080, { limitName: "Fable", advisory: true }),
  };
  // Codex's `account/rateLimits/read`: its primary and secondary windows, by their lengths.
  codex.quota.windows = {
    "codex:primary": reading(40, 300),
    "codex:secondary": reading(9, 10080),
  };
  await app.open("/usage");
  const labels = async (provider: string) =>
    within(await accountBlock(provider, "Personal"))
      .getAllByRole("meter")
      .map((each) => [each.getAttribute("aria-label"), each.getAttribute("aria-valuenow")]);
  expect(await labels("Claude Code")).toEqual([
    ["Session (5h)", "68"],
    ["Weekly", "3"],
    ["Weekly · Fable", "94"],
  ]);
  expect(await labels("Codex")).toEqual([
    ["Session (5h)", "60"],
    ["Weekly", "91"],
  ]);
  expect((await accountBlock("Claude Code", "Personal")).textContent).not.toContain(
    "No session (5h) limit",
  );
});

test("an account that reports no session window says so instead of leaving it out", async () => {
  const app = harness();
  report(app.daemon, "codex-personal", { "codex:primary": [2, 29 * day, 43200] });
  await app.open("/usage");
  const personal = await accountBlock("Codex", "Personal");
  expect(personal.textContent).toContain("Monthly");
  expect(personal.textContent).toContain("No session (5h) limit reported for this account");
});

test("Refresh asks each environment for current limits and shows what comes back", async () => {
  const app = harness();
  report(app.daemon, "codex-personal", { five_hour: [40, hour] });
  await app.open("/usage");
  expect((await meter("Codex", "Personal", "Session (5h)")).getAttribute("aria-valuenow")).toBe(
    "60",
  );
  report(app.daemon, "codex-personal", { five_hour: [10, hour] }, 3);
  await userEvent.click(screen.getByRole("button", { name: "Refresh" }));
  await waitFor(async () =>
    expect((await meter("Codex", "Personal", "Session (5h)")).getAttribute("aria-valuenow")).toBe(
      "90",
    ),
  );
  expect((await accountBlock("Codex", "Personal")).textContent).toContain("3 banked resets");
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
  await waitFor(() => expect(stat("Processed tokens")).toBe("6M"));

  await userEvent.click(screen.getByRole("button", { name: "Provider: All providers" }));
  await userEvent.click(await screen.findByRole("menuitemradio", { name: "Codex" }));
  await waitFor(() => expect(stat("Processed tokens")).toBe("3M"));
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
  expect((await meter("Codex", "Team", "Session (5h)")).getAttribute("aria-valuenow")).toBe("50");

  await show("Tokens");
  await userEvent.click(await screen.findByRole("button", { name: "7 days" }));
  await waitFor(() => expect(stat("Processed tokens")).toBe("700K"));
  await userEvent.click(screen.getByRole("button", { name: "Environment: Build server" }));
  await userEvent.click(await screen.findByRole("menuitemradio", { name: "All environments" }));
  await waitFor(() => expect(stat("Processed tokens")).toBe("1.4M"));
});

test("an account shows the plan its provider reports beside its environment", async () => {
  const app = harness();
  report(app.daemon, "codex-personal", { five_hour: [40, hour] });
  report(app.daemon, "codex-team", { five_hour: [40, hour] });
  const account = app.daemon.services.accounts.find((entry) => entry.id === "codex-personal");
  if (!account) throw new Error("no account");
  account.quota.plan = "plus";
  await app.open("/usage");
  expect((await accountBlock("Codex", "Personal")).textContent).toMatch(/Plus · /);
  expect((await accountBlock("Codex", "Team")).textContent).not.toContain("Plus");
});

test("an account whose login lapsed says to sign in again and shows no figure", async () => {
  const app = harness();
  const account = app.daemon.services.accounts.find((entry) => entry.id === "gemini-google");
  if (!account) throw new Error("no account");
  account.quota.windows = {};
  account.quota.usageNotice = {
    reason: "signed_out",
    message: "Sign in again in Gemini CLI",
    observedAt: now,
  };
  await app.open("/usage");
  const google = await screen.findByRole("article", { name: / · Google · / });
  expect(google.textContent).toContain("Sign in again in Gemini CLI");
  expect(within(google).queryAllByRole("meter")).toEqual([]);
});

test("a usage read that couldn't be made shows nothing for the account", async () => {
  const app = harness();
  report(app.daemon, "codex-personal", { five_hour: [40, hour] });
  const account = app.daemon.services.accounts.find((entry) => entry.id === "gemini-google");
  if (!account) throw new Error("no account");
  account.quota.windows = {};
  account.quota.usageNotice = {
    reason: "unavailable",
    message: "Gemini CLI usage couldn't be reached",
    observedAt: now,
  };
  await app.open("/usage");
  await accountBlock("Codex", "Personal");
  expect(screen.queryByRole("article", { name: / · Google · / })).toBeNull();
  expect(document.body.textContent).not.toContain("couldn't be reached");
});

test("using a banked reset requires confirmation and refreshes the account's balance and limits", async () => {
  const app = harness();
  report(app.daemon, "codex-personal", { "codex:primary": [100, hour, 300] }, 2);
  await app.open("/usage");
  const account = await accountBlock("Codex", "Personal");
  await userEvent.click(within(account).getByRole("button", { name: "Use reset" }));
  const dialog = await screen.findByRole("dialog", { name: "Use one banked reset?" });
  expect(within(account).getByText("2 banked resets")).toBeTruthy();
  await userEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
  expect(within(account).getByText("2 banked resets")).toBeTruthy();
  await userEvent.click(within(account).getByRole("button", { name: "Use reset" }));
  await userEvent.click(
    within(await screen.findByRole("dialog")).getByRole("button", { name: "Use reset" }),
  );
  await waitFor(() => expect(within(account).getByText("1 banked reset")).toBeTruthy());
  expect(
    within(account).getByRole("meter", { name: "Session (5h)" }).getAttribute("aria-valuenow"),
  ).toBe("100");
});

test("Claude's saved resets are visible with a route to its usage settings even without windows", async () => {
  const app = harness();
  report(app.daemon, "claude-personal", {}, 2);
  await app.open("/usage");
  const account = await accountBlock("Claude Code", "Personal");
  expect(within(account).getByText("2 banked resets")).toBeTruthy();
  expect(
    within(account).getByRole("link", { name: "Use reset in Claude" }).getAttribute("href"),
  ).toBe("https://claude.ai/settings/usage");
});

test("redeeming a remote account's reset spends only that environment's balance", async () => {
  const app = harness({ machines: [{ hostId: "build", name: "Build server" }] });
  const remote = app.machines.get("build");
  if (!remote) throw new Error("missing build server");
  report(app.daemon, "codex-personal", { "codex:primary": [100, hour, 300] }, 2);
  report(remote, "codex-personal", { "codex:primary": [100, hour, 300] }, 5);
  await app.open("/usage");
  const remoteBlock = await screen.findByRole("article", {
    name: "Codex · Personal · Build server",
  });
  await userEvent.click(within(remoteBlock).getByRole("button", { name: "Use reset" }));
  await userEvent.click(
    within(await screen.findByRole("dialog")).getByRole("button", { name: "Use reset" }),
  );
  await waitFor(() => expect(within(remoteBlock).getByText("4 banked resets")).toBeTruthy());
  expect(
    within(screen.getByRole("article", { name: "Codex · Personal · This Mac" })).getByText(
      "2 banked resets",
    ),
  ).toBeTruthy();
});

test("the total says how it grew against the same number of days before the range", async () => {
  const app = harness();
  const usage = app.daemon.services.usage;
  const answer = usage.report.bind(usage);
  const thisWeek = now - 7 * day;
  // Twice the tokens this week as the week before.
  usage.report = (query, kind) => {
    const scale = Date.parse(query.from) >= thisWeek ? 2 : 1;
    usage.sources = [
      { ...source("codex", "codex-personal", "gpt-5.3-codex", 5), daily: 80_000 * scale },
    ];
    return answer(query, kind);
  };
  await app.open("/usage");
  await show("Tokens");
  await userEvent.click(await screen.findByRole("button", { name: "7 days" }));
  await waitFor(() =>
    expect(screen.getByTestId("usage-growth").textContent).toBe("+100% vs previous 7 days"),
  );
  expect(
    within(screen.getByRole("listitem", { name: "Codex" })).getByLabelText("+100% growth"),
  ).toBeTruthy();
});

test("the figures name every machine they count, and one that goes offline is named, not dropped", async () => {
  const app = harness({ machines: [{ hostId: "build-server", name: "Build server" }] });
  const server = app.machines.get("build-server");
  if (!server) throw new Error("no build server");
  app.daemon.services.usage.sources = [source("codex", "codex-personal", "gpt-5.3-codex", 5)];
  server.services.usage.sources = [source("codex", "codex-team", "gpt-5.3-codex", 5)];
  await app.open("/usage");
  await waitFor(() =>
    expect(screen.getByTestId("usage-coverage").textContent).toBe("All 2 machines"),
  );

  await show("Tokens");
  await userEvent.click(await screen.findByRole("button", { name: "7 days" }));
  await waitFor(() => expect(stat("Processed tokens")).toBe("1.4M"));
  expect(screen.getByTestId("usage-coverage").textContent).toBe("All 2 machines");

  app.crashMachine("build-server");
  await waitFor(() =>
    expect(screen.getByTestId("usage-coverage").textContent).toBe(
      "1 of 2 machines · Build server is offline",
    ),
  );
  await waitFor(() => expect(stat("Processed tokens")).toBe("700K"));

  await show("Limits");
  expect(screen.getByTestId("usage-coverage").textContent).toBe(
    "1 of 2 machines · Build server is offline",
  );
  expect(screen.queryByRole("article", { name: /· Build server$/ })).toBeNull();
});
