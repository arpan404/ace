import type { FakeDaemon, UsageSource } from "@ace/fake-daemon";
import { configure, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { harness } from "@/test/harness.tsx";

configure({ asyncUtilTimeout: 10_000 });
vi.setConfig({ testTimeout: 30_000 });

const minute = 60_000;
const now = Date.parse("2036-10-01T15:00:00Z");
beforeEach(() => vi.useFakeTimers({ toFake: ["Date"], now }));
afterEach(() => vi.useRealTimers());

/**
 * One account's limits: its five-hour session (share used, minutes until it resets) and its week
 * (share used, resetting in three days).
 */
function session(
  daemon: FakeDaemon,
  id: string,
  used: number,
  resetsInMins: number,
  weekUsed = 20,
) {
  const account = daemon.services.accounts.find((entry) => entry.id === id);
  if (!account) throw new Error(`no account ${id}`);
  account.quota.windows = {
    five_hour: {
      usedPercent: used,
      resetsAt: now + resetsInMins * minute,
      windowDurationMins: 300,
    },
    seven_day: {
      usedPercent: weekUsed,
      resetsAt: now + 3 * 24 * 60 * minute,
      windowDurationMins: 10080,
    },
  };
}

const source = (provider: string, account: string, daily: number): UsageSource => ({
  provider,
  account,
  model: "gpt-5.3-codex",
  daily,
  steady: true,
  apiUsdPerMillion: 5,
  billing: "subscription",
  threads: [`thread-${provider}`],
});

const appNav = () => screen.findByRole("navigation", { name: "App" });

test("the rail's Usage icon says four accounts' weeks in words, most used first", async () => {
  const app = harness();
  session(app.daemon, "claude-personal", 62, 121, 41);
  session(app.daemon, "claude-work", 86, 180, 57);
  session(app.daemon, "codex-personal", 38, 180, 22);
  session(app.daemon, "codex-team", 100, 88, 88);
  app.daemon.services.usage.sources = [
    source("codex", "codex-personal", 900_000),
    source("claude", "claude-personal", 100_000),
  ];
  await app.open("/new");
  // Used most this week first (Codex Personal, then Claude Personal); the rest fill to four.
  expect(
    await within(await appNav()).findByRole("link", {
      name: "Usage: Codex · Personal 78% of the week left, Claude Code · Personal 59%, Claude Code · Work 43%, Codex · Team 12%",
    }),
  ).toBeTruthy();
});

test("an account out for the week reads out in the icon's name; the card names who is out", async () => {
  const app = harness();
  session(app.daemon, "codex-personal", 100, 88, 100);
  session(app.daemon, "codex-team", 100, 150, 100);
  session(app.daemon, "claude-personal", 10, 200, 10);
  session(app.daemon, "claude-work", 10, 200, 10);
  app.daemon.services.usage.sources = [
    source("codex", "codex-personal", 900_000),
    source("claude", "claude-personal", 100_000),
  ];
  await app.open("/new");
  const usage = await within(await appNav()).findByRole("link", {
    name: "Usage: Codex · Personal out for the week, Claude Code · Personal 90% of the week left, Claude Code · Work 90%, Codex · Team out for the week",
  });
  await userEvent.hover(usage);
  // Both Codex accounts have spent their week; the first comes back when its week resets.
  const card = await screen.findByText("Codex is out; it's back in 3d.");
  const body = card.closest("[data-slot=usage-card]");
  const codex =
    body && within(body as HTMLElement).getByRole("region", { name: "Codex · Personal" });
  expect(codex).toBeTruthy();
  // Each account the bars draw is named, with its limits as the Usage page draws them.
  expect(
    within(codex as HTMLElement)
      .getAllByRole("meter")
      .map((each) => [each.getAttribute("aria-label"), each.getAttribute("aria-valuenow")]),
  ).toContainEqual(["Weekly", "0"]);
  await userEvent.click(within(body as HTMLElement).getByRole("link", { name: "Open Usage ›" }));
  await waitFor(() =>
    expect(screen.getByRole("heading", { level: 2, name: "Usage" })).toBeTruthy(),
  );
});

test("the card says when a window runs out as a countdown, like the reset waits beside it", async () => {
  const app = harness();
  // Nine tenths of the session gone in its first hour: out in about seven minutes.
  session(app.daemon, "codex-personal", 90, 4 * 60, 10);
  app.daemon.services.usage.sources = [source("codex", "codex-personal", 900_000)];
  await app.open("/new");
  const usage = await within(await appNav()).findByRole("link", {
    name: /^Usage: Codex · Personal/,
  });
  await userEvent.hover(usage);
  const card = (await screen.findByRole("link", { name: "Open Usage ›" })).closest(
    "[data-slot=usage-card]",
  ) as HTMLElement;
  expect(within(card).getByText("Out in 7m")).toBeTruthy();
});

test("with no limits read, the icon shows empty bars and says so", async () => {
  const app = harness();
  for (const account of app.daemon.services.accounts) account.quota.windows = {};
  await app.open("/new");
  expect(
    await within(await appNav()).findByRole("link", { name: "Usage: no limits read yet" }),
  ).toBeTruthy();
});

test("Settings › General switches the rail's bars between each account's week and session", async () => {
  const app = harness();
  session(app.daemon, "claude-personal", 62, 121, 41);
  session(app.daemon, "codex-personal", 38, 180, 22);
  app.daemon.services.usage.sources = [
    source("codex", "codex-personal", 900_000),
    source("claude", "claude-personal", 100_000),
  ];
  await app.open("/settings/general");
  expect(
    await within(await appNav()).findByRole("link", {
      name: /^Usage: Codex · Personal 78% of the week left, Claude Code · Personal 59%/,
    }),
  ).toBeTruthy();
  const choice = await screen.findByRole("group", { name: "Usage bars" });
  await userEvent.click(within(choice).getByRole("button", { name: "Session" }));
  expect(
    await within(await appNav()).findByRole("link", {
      name: /^Usage: Codex · Personal 62% of the session left, Claude Code · Personal 38%/,
    }),
  ).toBeTruthy();
});

test("accounts pinned on the Usage page are the rail's, its card says so, and unpinning gives back the most used", async () => {
  const app = harness();
  session(app.daemon, "codex-personal", 30, 120, 20);
  session(app.daemon, "codex-team", 50, 120, 40);
  session(app.daemon, "claude-personal", 10, 200, 10);
  app.daemon.services.usage.sources = [source("claude", "claude-personal", 900_000)];
  await app.open("/usage");
  const team = await screen.findByRole("article", { name: /^Codex · Team · / });
  await userEvent.click(within(team).getByRole("button", { name: "Pin Codex · Team to the rail" }));
  const usage = await within(await appNav()).findByRole("link", {
    name: "Usage: Codex · Team 60% of the week left",
  });
  await userEvent.hover(usage);
  const card = (await screen.findByText("Pinned")).closest("[data-slot=usage-card]") as HTMLElement;
  expect(
    within(card)
      .getAllByRole("region")
      .map((each) => each.getAttribute("aria-label")),
  ).toEqual(["Codex · Team"]);
  await userEvent.click(
    within(team).getByRole("button", { name: "Unpin Codex · Team from the rail" }),
  );
  await waitFor(() =>
    expect(
      within(screen.getByRole("navigation", { name: "App" }))
        .getByRole("link", { name: /^Usage: / })
        .getAttribute("aria-label"),
    ).toMatch(/^Usage: Claude Code/),
  );
});
