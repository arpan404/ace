import { accountLimit } from "@ace/fake-daemon";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, test } from "vitest";
import { harness } from "@/test/harness.tsx";

beforeEach(() => localStorage.clear());

const minute = 60_000;
const hour = 60 * minute;
type App = ReturnType<typeof harness>;

/** What the daemon reports for one account: each window's share used and when it resets. */
function report(
  app: App,
  id: string,
  windows: Record<string, [used: number, resetsIn: number | null]>,
  availability: "available" | "near_limit" | "exhausted" = "available",
) {
  const account = app.daemon.services.accounts.find((entry) => entry.id === id);
  if (!account) throw new Error(`no account ${id}`);
  account.availability = availability;
  account.quota.windows = Object.fromEntries(
    Object.entries(windows).map(([window, [usedPercent, resetsIn]]) => [
      window,
      { usedPercent, resetsAt: resetsIn === null ? null : Date.now() + resetsIn },
    ]),
  );
}

/** A Claude thread working on the Personal account, open. */
async function openOnPersonal(app: App) {
  app.play(accountLimit("thread-usage", "Tidy the request logger", "claude-personal")).step();
  await app.open("/t/thread-usage");
  await screen.findByRole("combobox", { name: "Message" });
}

test("the composer shows its account's tightest window, and every window with its reset on click", async () => {
  const app = harness();
  report(app, "claude-personal", {
    five_hour: [62, 2 * hour],
    seven_day: [41, 4 * 24 * hour],
  });
  await openOnPersonal(app);

  const meter = await screen.findByRole("meter", { name: "Claude Code · Personal usage" });
  expect(meter.textContent).toBe("5h 62%");
  expect(meter.getAttribute("aria-valuetext")).toMatch(
    /^62% of 5-hour window used, resets .* in 2h/,
  );

  await userEvent.hover(meter);
  const card = await screen.findByRole("tooltip");
  const fiveHour = within(card).getByRole("meter", { name: "5-hour window" });
  expect(fiveHour.getAttribute("aria-valuenow")).toBe("62");
  expect(
    within(card).getByRole("meter", { name: "Weekly window" }).getAttribute("aria-valuetext"),
  ).toMatch(/^41% used, resets .* in 4d$/);
  // Nothing is near a limit, so no advice about other accounts.
  expect(within(card).queryByText(/has \d+% left/)).toBeNull();
});

test("near its limit, a warning says when the window resets and what the thread will do at the limit", async () => {
  const app = harness();
  app.daemon.services.settings.seed({ "threads.limitPolicy": "migrate_now" });
  report(app, "claude-personal", { five_hour: [91, 90 * minute] }, "near_limit");
  report(app, "claude-work", { five_hour: [23, 3 * hour] });
  await openOnPersonal(app);

  const warning = await screen.findByRole("region", { name: "Near the usage limit" });
  expect(
    within(warning).getByText("Claude Code · Personal has used 91% of its 5-hour window"),
  ).toBeTruthy();
  expect(
    within(warning).getByText(/in 1h 3\dm\. At the limit it moves to Claude Code · Work\.$/),
  ).toBeTruthy();
  expect(
    (await screen.findByRole("meter", { name: "Claude Code · Personal usage" })).textContent,
  ).toBe("5h 91%");

  await userEvent.click(within(warning).getByRole("button", { name: "Dismiss" }));
  await waitFor(() =>
    expect(screen.queryByRole("region", { name: "Near the usage limit" })).toBeNull(),
  );
});

test("at its limit, the thread says when its account resets and moves to the account with room", async () => {
  const app = harness();
  report(
    app,
    "codex-team",
    { five_hour: [100, 87 * minute], seven_day: [88, 6 * 24 * hour] },
    "exhausted",
  );
  report(app, "codex-personal", { five_hour: [38, 3 * hour] });
  app.play(accountLimit("thread-capped", "Split the CI matrix by package")).runThrough("limited");
  await app.open("/t/thread-capped");

  const notice = await screen.findByRole("region", { name: "Usage limit reached" });
  // The thread didn't say when it can go on; its account did.
  expect(
    within(notice).getByText(/^Codex · Team resets .*, in 1h 2\dm\. Queued messages wait\.$/),
  ).toBeTruthy();
  expect(within(notice).getByRole("button", { name: "Resume at reset" })).toBeTruthy();
  expect(await screen.findByText(/Limited until/)).toBeTruthy();

  await userEvent.click(within(notice).getByRole("button", { name: "Move to Codex · Personal" }));

  await waitFor(() => {
    const list = app.daemon.snapshot({ kind: "threads" });
    const thread = list && "threads" in list ? list.threads["thread-capped"] : undefined;
    expect([thread?.live?.account, thread?.status.state]).toEqual(["codex-personal", "working"]);
  });
});
