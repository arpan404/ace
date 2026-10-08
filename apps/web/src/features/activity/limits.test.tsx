import { teamAtLimit } from "@ace/fake-daemon";
import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { harness } from "@/test/harness.tsx";

const minute = 60_000;
const hour = 60 * minute;
/**
 * The wall clock, held still so countdowns read exactly. Later than any real clock the suite runs
 * at, since the page's shared minute clock never runs backwards.
 */
const now = Date.parse("2036-10-01T15:00:00");

beforeEach(() => {
  localStorage.clear();
  vi.useFakeTimers({ toFake: ["Date"], now });
});
afterEach(() => {
  vi.useRealTimers();
  visibility("visible");
});

type App = ReturnType<typeof harness>;

const toasts = () => screen.getByRole("region", { name: "Notifications" });
/** Usage & accounts reads quota again; every screen showing it gets the new reading. */
const refresh = () => userEvent.click(screen.getByRole("button", { name: "Refresh" }));

/**
 * What the daemon reports for one account: each window's share used and when it resets (from the
 * held clock), and whether its CLI has said it is signed in.
 */
function report(
  app: App,
  id: string,
  windows: Record<string, [used: number, resetsIn: number]>,
  auth: "logged_in" | "unknown" = "logged_in",
) {
  const account = app.daemon.services.accounts.find((entry) => entry.id === id);
  if (!account) throw new Error(`no account ${id}`);
  account.quota.auth = auth;
  account.quota.windows = Object.fromEntries(
    Object.entries(windows).map(([window, [usedPercent, resetsIn]]) => [
      window,
      { usedPercent, resetsAt: now + resetsIn },
    ]),
  );
}

/** Hide or show the page, as switching tabs or minimising the window does. */
function visibility(state: DocumentVisibilityState) {
  Object.defineProperty(document, "visibilityState", { configurable: true, value: state });
  document.dispatchEvent(new Event("visibilitychange"));
}

/** Claude Code · Work at its 5-hour limit, a moment before that window resets, on Usage & accounts. */
async function workAtLimit(app: App) {
  report(app, "claude-work", { five_hour: [100, 1] });
  await app.open("/accounts");
  const work = await screen.findByRole("article", { name: "Claude Code Work" });
  expect(within(work).getByText("Limit reached")).toBeTruthy();
}

test("Activity lists threads paused at a usage limit by account and moves them to one with room", async () => {
  const app = harness();
  report(app, "codex-team", { five_hour: [100, 87 * minute] });
  report(app, "codex-personal", { five_hour: [38, 3 * hour] });
  for (const scenario of teamAtLimit()) app.play(scenario).runThrough("limited");
  await app.open("/activity");

  const team = await screen.findByRole("article", { name: "Codex · Team" });
  expect(
    within(team).getByText(/^3 threads paused · Resets \d{1,2}:\d{2}(?: [ap]m)? · in 1h 27m$/i),
  ).toBeTruthy();
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
  await app.open("/accounts");
  await screen.findByRole("article", { name: "Claude Code Work" });

  report(app, "claude-work", { five_hour: [92, 2 * hour] });
  await refresh();
  expect(
    await within(toasts()).findByText("Claude Code · Work is near its usage limit"),
  ).toBeTruthy();
  expect(within(toasts()).getByText(/^92% of the 5-hour window used\. Resets/)).toBeTruthy();

  report(app, "claude-work", { five_hour: [100, 2 * hour] });
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
  await app.open("/accounts");
  const work = await screen.findByRole("article", { name: "Claude Code Work" });

  report(app, "claude-work", { five_hour: [100, 2 * hour] });
  await userEvent.click(screen.getByRole("button", { name: "Refresh" }));
  // The page has the new reading, and no toast came with it.
  expect(await within(work).findByText("Limit reached")).toBeTruthy();
  expect(screen.queryByText("Claude Code · Work reached its usage limit")).toBeNull();
});

test("losing track of an account at its limit doesn't say it can work again; a reading with room does", async () => {
  const app = harness();
  await workAtLimit(app);

  // Its CLI stops saying it is signed in and reports no windows: nothing is known either way.
  report(app, "claude-work", {}, "unknown");
  await refresh();
  const work = screen.getByRole("article", { name: "Claude Code Work" });
  await waitFor(() => expect(within(work).queryByText("Limit reached")).toBeNull());
  expect(within(toasts()).queryByText("Claude Code · Work can work again")).toBeNull();

  report(app, "claude-work", { five_hour: [4, 5 * hour] });
  await refresh();
  expect(await within(toasts()).findByText("Claude Code · Work can work again")).toBeTruthy();
});

test("once its full window resets, the account says it can work again without anything new from the provider", async () => {
  const app = harness();
  await workAtLimit(app);

  // The reset passes; the daemon still holds the same quota, and nobody presses Refresh.
  vi.setSystemTime(now + 3_000);
  expect(
    await within(toasts()).findByText("Claude Code · Work can work again", {}, { timeout: 6_000 }),
  ).toBeTruthy();
}, 10_000);

test("a hidden page doesn't read quota at a reset; it reads once shown again", async () => {
  const app = harness();
  await workAtLimit(app);

  visibility("hidden");
  vi.setSystemTime(now + 3_000);
  // Longer than the read after a reset waits: none happens while hidden.
  await act(() => new Promise((resolve) => setTimeout(resolve, 2_500)));
  expect(within(toasts()).queryByText("Claude Code · Work can work again")).toBeNull();

  visibility("visible");
  expect(
    await within(toasts()).findByText("Claude Code · Work can work again", {}, { timeout: 6_000 }),
  ).toBeTruthy();
}, 15_000);
