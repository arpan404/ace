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

const toasts = () => screen.findByRole("region", { name: "Notifications" });
/** Usage reads quota again; every screen showing it gets the new reading. */
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

/** Usage's 5-hour bar for Claude Code · Work: what is left of it. */
const workMeter = () => {
  const work = screen.queryByRole("article", { name: /^Claude Code · Work · / });
  return work ? within(work).queryByRole("meter", { name: "5-hour" }) : null;
};
const findWorkMeter = () =>
  waitFor(() => {
    const meter = workMeter();
    if (!meter) throw new Error("no 5-hour meter for Claude Code · Work");
    return meter;
  });

/** Claude Code · Work at its 5-hour limit, a moment before that window resets, on Usage. */
async function workAtLimit(app: App) {
  report(app, "claude-work", { five_hour: [100, 1] });
  await app.open("/usage");
  const work = await findWorkMeter();
  expect(work.getAttribute("aria-valuetext")).toMatch(/^0% left/);
}

test("toasts say when an account nears its limit, reaches it and can work again", async () => {
  const app = harness();
  report(app, "claude-work", { five_hour: [60, 2 * hour] });
  // Commit the lazy limit notifier and its initial reading before changing the provider quota.
  await act(async () => {
    await app.open("/usage");
  });
  await findWorkMeter();

  report(app, "claude-work", { five_hour: [92, 2 * hour] });
  await refresh();
  expect(
    await within(await toasts()).findByText("Claude Code · Work is near its usage limit"),
  ).toBeTruthy();
  expect(within(await toasts()).getByText(/^92% of the 5-hour window used\. Resets/)).toBeTruthy();

  report(app, "claude-work", { five_hour: [100, 2 * hour] });
  await refresh();
  expect(
    await within(await toasts()).findByText("Claude Code · Work reached its usage limit"),
  ).toBeTruthy();

  report(app, "claude-work", { five_hour: [4, 5 * hour] });
  await refresh();
  expect(await within(await toasts()).findByText("Claude Code · Work can work again")).toBeTruthy();
});

test("with limit toasts turned off, an account reaching its limit stays quiet", async () => {
  localStorage.setItem("ace.notifications.toasts", JSON.stringify({ limits: false }));
  const app = harness();
  report(app, "claude-work", { five_hour: [60, 2 * hour] });
  await app.open("/usage");
  await findWorkMeter();

  report(app, "claude-work", { five_hour: [100, 2 * hour] });
  await userEvent.click(screen.getByRole("button", { name: "Refresh" }));
  // The page has the new reading, and no toast came with it.
  await waitFor(() => expect(workMeter()?.getAttribute("aria-valuenow")).toBe("0"));
  expect(screen.queryByText("Claude Code · Work reached its usage limit")).toBeNull();
});

test("losing track of an account at its limit doesn't say it can work again; a reading with room does", async () => {
  const app = harness();
  await workAtLimit(app);

  // Its CLI stops saying it is signed in and reports no windows: nothing is known either way.
  report(app, "claude-work", {}, "unknown");
  await refresh();
  await waitFor(() => expect(workMeter()).toBeNull());
  expect(screen.queryByText("Claude Code · Work can work again")).toBeNull();

  report(app, "claude-work", { five_hour: [4, 5 * hour] });
  await refresh();
  expect(await within(await toasts()).findByText("Claude Code · Work can work again")).toBeTruthy();
});

test("once its full window resets, the account says it can work again without anything new from the provider", async () => {
  const app = harness();
  await workAtLimit(app);

  // The reset passes; the daemon still holds the same quota, and nobody presses Refresh.
  vi.setSystemTime(now + 3_000);
  expect(
    await screen.findByText("Claude Code · Work can work again", {}, { timeout: 6_000 }),
  ).toBeTruthy();
}, 10_000);

test("a hidden page doesn't read quota at a reset; it reads once shown again", async () => {
  const app = harness();
  await workAtLimit(app);

  visibility("hidden");
  vi.setSystemTime(now + 3_000);
  // Longer than the read after a reset waits: none happens while hidden.
  await act(() => new Promise((resolve) => setTimeout(resolve, 2_500)));
  expect(screen.queryByText("Claude Code · Work can work again")).toBeNull();

  visibility("visible");
  expect(
    await screen.findByText("Claude Code · Work can work again", {}, { timeout: 6_000 }),
  ).toBeTruthy();
}, 15_000);
