import { accountLimit, facts } from "@ace/fake-daemon";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { describeWake } from "@ace/ui-core";
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

test("at its limit, the thread says when its account resets; Switch to an account with room carries the held work on there", async () => {
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
    if (p.type === "thread.limit")
      sent.push(`limit:${p.action}${p.selection ? `:${p.selection.instanceId ?? ""}` : ""}`);
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

  // Switch lists the accounts with room first, with how much is left.
  await userEvent.click(within(notice).getByRole("button", { name: "Switch" }));
  const room = await screen.findByRole("list", { name: "Accounts with room" });
  const [first] = within(room).getAllByRole("button");
  expect(first?.textContent).toContain("Codex · Personal62% left");
  if (!first) throw new Error("No account with room");

  // One pick: the held turn carries on there, with no Continue and no message from the person.
  await userEvent.click(first);
  await waitFor(() => expect(sent).toEqual(["limit:switch:codex-personal"]));
  await waitFor(() =>
    expect(screen.queryByRole("region", { name: "Codex is out of usage" })).toBeNull(),
  );
  const feed = screen.getByRole("feed", { name: "Transcript" });
  expect(
    await within(feed).findByText(/^Continued on Codex · .+ after the usage limit$/),
  ).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Continue" })).toBeNull();
});

test("Resume at reset says when it resumes with Cancel, and Cancel goes back to the limit", async () => {
  const app = harness();
  report(app, "codex-team", { five_hour: [100, 87 * minute] });
  app.play(accountLimit("thread-capped", "Split the CI matrix by package")).runThrough("limited");
  const actions: string[] = [];
  const command = app.daemon.command.bind(app.daemon);
  app.daemon.command = (value) => {
    if (value.payload.type === "thread.limit") actions.push(value.payload.action);
    return command(value);
  };
  await app.open("/t/thread-capped");
  const notice = await screen.findByRole("region", { name: "Codex is out of usage" });
  await userEvent.click(await within(notice).findByRole("button", { name: "Resume at reset" }));
  const scheduled = await screen.findByRole("region", { name: "Scheduled resume" });
  expect(scheduled.textContent).toBe(
    `Resumes at ${describeWake(now + 87 * minute, now)} when Codex resets · in 1h 27mSwitchCancel`,
  );
  expect(within(scheduled).queryByRole("button", { name: "Continue" })).toBeNull();

  await userEvent.click(within(scheduled).getByRole("button", { name: "Cancel" }));
  const limited = await screen.findByRole("region", { name: "Codex is out of usage" });
  expect(within(limited).getByRole("button", { name: "Resume at reset" })).toBeTruthy();
  expect(within(limited).getByRole("button", { name: "Continue" })).toBeTruthy();
  expect(actions).toEqual(["resume_at_reset", "cancel_resume"]);
});

test("a Claude child's limit does not label the Codex parent as exhausted or offer root quota recovery", async () => {
  const app = harness();
  app.daemon.createThread({
    id: "mixed-quota",
    workspaceId: "relay",
    provider: "codex",
    title: "Continue on Codex",
  });
  app.daemon.apply("mixed-quota", [
    facts.rootAgent("codex"),
    { type: "turn.started", agent: "root", nativeTurnId: "codex-turn", trigger: "user" },
    { type: "turn.ended", agent: "root", nativeTurnId: "codex-turn", outcome: "completed" },
    {
      type: "agent.seen",
      agent: "claude-child",
      parent: "root",
      origin: "provider_subagent",
      fidelity: "full",
      cwd: "/repo",
      native: { provider: "claude", nativeId: "claude-child-session" },
    },
    { type: "turn.started", agent: "claude-child", nativeTurnId: "child-turn", trigger: "user" },
    {
      type: "turn.ended",
      agent: "claude-child",
      nativeTurnId: "child-turn",
      outcome: "failed",
      error: { kind: "quota", message: "Claude allowance exhausted" },
    },
    { type: "retry", agent: "claude-child", on: "rate_limit", until: now + hour },
  ]);
  await app.open("/t/mixed-quota");
  expect(await screen.findByRole("combobox", { name: "Message" })).toBeTruthy();
  expect(screen.queryByRole("region", { name: /Codex is (out of usage|rate limited)/ })).toBeNull();
  expect(screen.queryByRole("button", { name: "Resume at reset" })).toBeNull();
  await userEvent.type(
    screen.getByRole("combobox", { name: "Message" }),
    "recover the Claude child",
  );
  expect(await screen.findByRole("button", { name: "Send" })).toBeTruthy();
});
