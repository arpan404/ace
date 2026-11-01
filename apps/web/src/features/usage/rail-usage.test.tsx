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

/** One account's five-hour session: share used, minutes until it resets. */
function session(daemon: FakeDaemon, id: string, used: number, resetsInMins: number) {
  const account = daemon.services.accounts.find((entry) => entry.id === id);
  if (!account) throw new Error(`no account ${id}`);
  account.quota.windows = {
    five_hour: {
      usedPercent: used,
      resetsAt: now + resetsInMins * minute,
      windowDurationMins: 300,
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

test("the rail's Usage icon says each account's session in words, most used first", async () => {
  const app = harness();
  session(app.daemon, "claude-personal", 62, 121);
  session(app.daemon, "claude-work", 86, 180);
  session(app.daemon, "codex-personal", 38, 180);
  session(app.daemon, "codex-team", 100, 88);
  app.daemon.services.usage.sources = [
    source("codex", "codex-personal", 900_000),
    source("claude", "claude-personal", 100_000),
  ];
  await app.open("/new");
  // One bar per account used this week, Codex's Personal first: it was used most.
  expect(
    await within(await appNav()).findByRole("link", {
      name: "Usage: Codex · Personal 62% of session left, Claude Code · Personal 38%",
    }),
  ).toBeTruthy();
});

test("a provider out on every account reads out in the icon's name and its card", async () => {
  const app = harness();
  session(app.daemon, "codex-personal", 100, 88);
  session(app.daemon, "codex-team", 100, 150);
  session(app.daemon, "claude-personal", 10, 200);
  session(app.daemon, "claude-work", 10, 200);
  app.daemon.services.usage.sources = [
    source("codex", "codex-personal", 900_000),
    source("claude", "claude-personal", 100_000),
  ];
  await app.open("/new");
  const usage = await within(await appNav()).findByRole("link", {
    name: "Usage: Codex · Personal out, Claude Code · Personal 90%",
  });
  await userEvent.hover(usage);
  const card = await screen.findByText("Codex is out; it's back in 1h 28m.");
  const body = card.closest("[data-slot=usage-card]");
  expect(body && within(body as HTMLElement).getByRole("region", { name: "Codex" })).toBeTruthy();
  await userEvent.click(within(body as HTMLElement).getByRole("link", { name: "Open Usage ›" }));
  await waitFor(() =>
    expect(screen.getByRole("heading", { level: 2, name: "Usage" })).toBeTruthy(),
  );
});

test("with no limits read, the icon shows empty bars and says so", async () => {
  const app = harness();
  for (const account of app.daemon.services.accounts) account.quota.windows = {};
  await app.open("/new");
  expect(
    await within(await appNav()).findByRole("link", { name: "Usage: no limits read yet" }),
  ).toBeTruthy();
});
