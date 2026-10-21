import { accountLimit } from "@ace/fake-daemon";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { describeWake } from "@ace/ui-core";
import { harness } from "@/test/harness.tsx";
import { closeModelControl, openModelPicker, selectAccount } from "@/test/model-control.ts";

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

test("at its limit, the thread says when its account resets; after switching account, a message sends at once", async () => {
  const app = harness();
  report(app, "codex-team", { five_hour: [100, 87 * minute], seven_day: [88, 6 * 24 * hour] });
  report(app, "codex-personal", { five_hour: [38, 3 * hour] });
  app.play(accountLimit("thread-capped", "Split the CI matrix by package")).runThrough("limited");
  // What reaches the daemon over the wire, in order.
  const sent: string[] = [];
  const command = app.daemon.command.bind(app.daemon);
  app.daemon.command = (value) => {
    const p = value.payload;
    if (p.type === "thread.switch") sent.push(`switch:${p.selection.instanceId ?? ""}`);
    if (p.type === "thread.limit") sent.push(`limit:${p.action}`);
    if (p.type === "thread.send") sent.push("send");
    return command(value);
  };
  await app.open("/t/thread-capped");

  // The thread didn't say when it can go on; its account did.
  const notice = await screen.findByRole("region", { name: "Codex is out of usage" });
  await waitFor(() =>
    expect(notice.textContent).toContain(`until ${describeWake(now + 87 * minute, now)}`),
  );
  const header = within(screen.getByRole("banner"));
  expect(header.queryByText("Limited")).toBeNull();
  expect(header.queryByRole("status")).toBeNull();

  // While the limit holds, a message would wait for the reset.
  const message = await screen.findByRole("combobox", { name: "Message" });
  await userEvent.type(message, "Pick the CI split back up");
  expect(await screen.findByRole("button", { name: "Queue message" })).toBeTruthy();

  // Switch opens the composer's picker; choosing another account takes the limit away at once.
  await userEvent.click(within(notice).getByRole("button", { name: "Switch" }));
  const popover = await screen.findByRole("dialog", { name: "Model and effort" });
  const models = await openModelPicker(popover);
  await selectAccount(popover, "Personal");
  const [model] = within(models).getAllByRole("option");
  if (!model) throw new Error("No model on Personal");
  await userEvent.click(model);
  await closeModelControl();
  expect(screen.queryByRole("region", { name: "Codex is out of usage" })).toBeNull();

  // The message now sends, after the switch, and the turn runs without waiting for the reset.
  await userEvent.click(await screen.findByRole("button", { name: "Send" }));
  await waitFor(() => expect(sent).toEqual(["switch:codex-personal", "send"]));
  const feed = screen.getByRole("feed", { name: "Transcript" });
  expect(await within(feed).findByText("Pick the CI split back up")).toBeTruthy();
  expect(screen.queryByRole("list", { name: "Queued messages" })).toBeNull();
});

test("Resume at reset schedules the turn, and the strip says when it resumes", async () => {
  const app = harness();
  report(app, "codex-team", { five_hour: [100, 87 * minute] });
  app.play(accountLimit("thread-capped", "Split the CI matrix by package")).runThrough("limited");
  await app.open("/t/thread-capped");
  const notice = await screen.findByRole("region", { name: "Codex is out of usage" });
  await userEvent.click(await within(notice).findByRole("button", { name: "Resume at reset" }));
  await waitFor(() =>
    expect(screen.getByRole("region", { name: "Codex is out of usage" }).textContent).toMatch(
      /· resumes (at )?.*\d/,
    ),
  );
  expect(screen.queryByRole("button", { name: "Resume at reset" })).toBeNull();
  expect(screen.getByRole("button", { name: "Continue" })).toBeTruthy();
});
