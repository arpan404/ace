import { accountLimit } from "@ace/fake-daemon";
import { screen, waitFor, within } from "@testing-library/react";
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
afterEach(() => vi.useRealTimers());

type App = ReturnType<typeof harness>;

/**
 * What the daemon reports for one account: each window's share used and when it resets, and
 * whether its CLI has said it is signed in.
 */
function report(
  app: App,
  id: string,
  windows: Record<string, [used: number, resetsIn: number | null]>,
  auth: "logged_in" | "unknown" = "logged_in",
) {
  const account = app.daemon.services.accounts.find((entry) => entry.id === id);
  if (!account) throw new Error(`no account ${id}`);
  account.quota.auth = auth;
  account.quota.windows = Object.fromEntries(
    Object.entries(windows).map(([window, [usedPercent, resetsIn]]) => [
      window,
      { usedPercent, resetsAt: resetsIn === null ? null : now + resetsIn },
    ]),
  );
}

test("at its limit, the thread says when its account resets and moves to the account with room", async () => {
  const app = harness();
  report(app, "codex-team", { five_hour: [100, 87 * minute], seven_day: [88, 6 * 24 * hour] });
  report(app, "codex-personal", { five_hour: [38, 3 * hour] });
  app.play(accountLimit("thread-capped", "Split the CI matrix by package")).runThrough("limited");
  await app.open("/t/thread-capped");

  const notice = await screen.findByRole("region", { name: "Usage limit reached" });
  // The thread didn't say when it can go on; its account did.
  expect(
    await within(notice).findByText(/^Codex · Team resets .*, in 1h 27m\. Queued messages wait\.$/),
  ).toBeTruthy();
  const header = within(screen.getByRole("banner"));
  expect(header.queryByText("Limited")).toBeNull();
  expect(header.queryByRole("status")).toBeNull();
  await userEvent.click(within(notice).getByRole("button", { name: "Limit actions" }));
  expect(within(notice).getByRole("button", { name: "Resume at reset" })).toBeTruthy();

  await userEvent.click(screen.getByRole("menuitem", { name: "Move to Codex · Personal" }));

  await waitFor(() => {
    const list = app.daemon.snapshot({ kind: "threads" });
    const thread = list && "threads" in list ? list.threads["thread-capped"] : undefined;
    expect([thread?.live?.account, thread?.status.state]).toEqual(["codex-personal", "working"]);
  });
});
