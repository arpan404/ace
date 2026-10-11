import { facts, workCardScenario } from "@ace/fake-daemon";
import { Automation, ThreadId } from "@ace/protocol";
import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, test } from "vitest";
import { harness } from "@/test/harness.tsx";

beforeEach(() => localStorage.clear());

async function openWork(app: ReturnType<typeof harness>, threadId: string) {
  await app.open(`/t/${threadId}`);
  await userEvent.click(await screen.findByRole("button", { name: /^Work card/ }));
  return screen.findByRole("complementary", { name: "Work card" });
}

test("an ended parent stays in running lineage until its nested child settles", async () => {
  const app = harness();
  const fixture = workCardScenario("changes");
  app.play(fixture).runUntilBlocked();
  const card = await openWork(app, fixture.thread.id);
  act(() => app.daemon.apply(fixture.thread.id, [facts.endTurn("worker-0")]));
  await waitFor(() =>
    expect(
      within(card)
        .getByRole("button", { name: /Open Write retry tests:/ })
        .getAttribute("aria-label"),
    ).not.toContain("done"),
  );
  expect(within(card).getByText("Lineage · 2 running")).toBeTruthy();
  act(() => app.daemon.apply(fixture.thread.id, [facts.endTurn("worker-1")]));
  await within(card).findByText("Lineage · 0 running");
  expect(within(card).queryByRole("button", { name: /Open Write retry tests:/ })).toBeNull();
  await userEvent.click(within(card).getByRole("button", { name: "Previous agents (3)" }));
  expect(within(card).getByRole("button", { name: "Open Write retry tests: done" })).toBeTruthy();
});

test("project schedules show their cadence and persist toggles and run-now results", async () => {
  const now = Date.now();
  const app = harness({ clock: () => now });
  const fixture = workCardScenario("worktree");
  app.play(fixture).runUntilBlocked();
  const automation = Automation.parse({
    id: "review",
    title: "Review changes",
    enabled: true,
    workspace: "relay",
    provider: "codex",
    prompt: "Review the latest changes",
    worktree: true,
    trigger: {
      kind: "schedule",
      schedule: {
        kind: "rrule",
        expression: "FREQ=MINUTELY;INTERVAL=5",
        timezone: "UTC",
        startAt: Math.floor(now / 60_000) * 60_000,
      },
    },
    missedRun: "skip",
    concurrency: 1,
    jitterMs: 0,
  });
  app.daemon.seedServices({
    automations: [
      automation,
      { ...automation, id: "elsewhere", title: "Other project", workspace: "other" },
    ],
    settings: { "automations.enabled": true },
  });
  const card = await openWork(app, fixture.thread.id);
  const section = within(card).getByRole("region", { name: "Automations" });
  await within(section).findByRole("button", { name: "Open automation Review changes" });
  expect(section.textContent).toContain("Every 5 minutes");
  expect(section.textContent).toMatch(/In |Any moment|Today|Tomorrow/);
  expect(within(section).queryByText("Other project")).toBeNull();
  await userEvent.click(within(section).getByRole("button", { name: "Run Review changes now" }));
  await waitFor(async () => {
    const inbox = await app.client.request({ type: "automation.inbox", limit: 10 });
    expect(inbox.inbox?.runs.some((run) => run.automationId === "review")).toBe(true);
  });
  await userEvent.click(within(section).getByRole("switch", { name: "Enable Review changes" }));
  await waitFor(async () => {
    const stored = await app.client.request({ type: "automation.list" });
    expect(stored.automations?.find((entry) => entry.id === "review")?.enabled).toBe(false);
  });
  await within(section).findByText(/Paused. Resume/);
  expect(
    within(section)
      .getByRole("button", { name: "Resume this automation to run it" })
      .hasAttribute("disabled"),
  ).toBe(true);
});

test("push waits for confirmation and cancellation leaves the branch unchanged", async () => {
  const app = harness();
  const fixture = workCardScenario("worktree");
  fixture.thread.details = { ...fixture.thread.details, ahead: 1 };
  app.play(fixture).runUntilBlocked();
  const card = await openWork(app, fixture.thread.id);
  const ahead = () => {
    const snapshot = app.daemon.snapshot({
      kind: "thread",
      threadId: ThreadId.parse(fixture.thread.id),
    });
    return snapshot && "thread" in snapshot ? snapshot.thread.details?.ahead : undefined;
  };
  await userEvent.click(within(card).getByRole("button", { name: "Commit and push options" }));
  await userEvent.click(await screen.findByRole("menuitem", { name: "Push" }));
  const confirm = await screen.findByRole("dialog", { name: "Push fix/restart-retry?" });
  expect(ahead()).toBe(1);
  await userEvent.click(within(confirm).getByRole("button", { name: "Cancel" }));
  expect(ahead()).toBe(1);
  await userEvent.click(within(card).getByRole("button", { name: "Commit and push options" }));
  await userEvent.click(await screen.findByRole("menuitem", { name: "Push" }));
  await userEvent.click(
    within(await screen.findByRole("dialog", { name: "Push fix/restart-retry?" })).getByRole(
      "button",
      { name: "Push" },
    ),
  );
  await waitFor(() => expect(ahead()).toBe(0));
});

test("adding a project script opens its configuration in the existing file editor", async () => {
  const app = harness();
  const fixture = workCardScenario("worktree");
  app.play(fixture).runUntilBlocked();
  const card = await openWork(app, fixture.thread.id);
  await userEvent.click(within(card).getByRole("button", { name: "Add project script" }));
  await userEvent.click(await screen.findByRole("menuitem", { name: "Edit package.json scripts" }));
  const panel = await screen.findByRole("region", { name: "Thread panel" });
  expect(
    await within(panel).findByRole("tab", { name: /package.json/, selected: true }),
  ).toBeTruthy();
  expect(screen.queryByRole("complementary", { name: "Work card" })).toBeNull();
});
