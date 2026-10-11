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

test("a child keeps working through a non-blocking question and requests attention after its turn ends", async () => {
  const app = harness();
  const fixture = workCardScenario("changes");
  app.play(fixture).runUntilBlocked();
  const card = await openWork(app, fixture.thread.id);
  act(() =>
    app.daemon.apply(fixture.thread.id, [
      {
        type: "interaction.opened",
        agent: "worker-1",
        interaction: "optional-question",
        blocking: false,
        request: {
          kind: "question",
          questions: [
            {
              id: "scope",
              text: "Which cases?",
              multiSelect: false,
              allowOther: true,
              options: [],
            },
          ],
        },
      },
    ]),
  );
  const lease = app.client.thread(fixture.thread.id);
  await waitFor(() =>
    expect(
      lease.store.interactionIds().some((id) => lease.store.interaction(id)?.state === "pending"),
    ).toBe(true),
  );
  lease.release();
  await waitFor(() =>
    expect(within(card).queryByRole("button", { name: /Open .*: Needs you/ })).toBeNull(),
  );
  expect(within(card).getByText("Lineage · 2 running")).toBeTruthy();
  expect(screen.queryByRole("img", { name: "Work needs you" })).toBeNull();
  act(() => app.daemon.apply(fixture.thread.id, [facts.endTurn("worker-1")]));
  expect(
    await within(card).findByRole("button", { name: "Open Check supervisor logs: Needs you" }),
  ).toBeTruthy();
  expect(
    within(card).getByRole("button", { name: "Open Write retry tests: Needs you" }),
  ).toBeTruthy();
  expect(await screen.findByRole("img", { name: "Work needs you" })).toBeTruthy();
});

test.each(["completed", "interrupted"] as const)(
  "a parent with an %s turn describes its active subtree on hover and focus",
  async (outcome) => {
    const app = harness();
    const fixture = workCardScenario("changes");
    app.play(fixture).runUntilBlocked();
    const card = await openWork(app, fixture.thread.id);
    act(() => app.daemon.apply(fixture.thread.id, [facts.endTurn("worker-0", outcome)]));
    const parent = await within(card).findByRole("button", {
      name: "Open Write retry tests: Waiting on work",
    });
    expect(
      within(parent).getByText("Waiting on work").closest("[data-tone]")?.getAttribute("data-tone"),
    ).toBe("waiting");
    await userEvent.hover(parent);
    expect((await screen.findByRole("tooltip")).textContent).toBe(
      "Write retry tests · Waiting on work",
    );
    await userEvent.unhover(parent);
    await waitFor(() => expect(screen.queryByRole("tooltip")).toBeNull());
    act(() => parent.focus());
    expect((await screen.findByRole("tooltip")).textContent).toBe(
      "Write retry tests · Waiting on work",
    );
  },
);

test("Escape from Project actions restores focus to its trigger and keeps Work open", async () => {
  const app = harness();
  const fixture = workCardScenario("worktree");
  app.play(fixture).runUntilBlocked();
  const card = await openWork(app, fixture.thread.id);
  const trigger = within(card).getByRole("button", { name: "Project actions" });
  act(() => trigger.focus());
  await userEvent.keyboard("{Enter}");
  await screen.findByRole("menu");
  await userEvent.keyboard("{Escape}");
  await waitFor(() => expect(document.activeElement).toBe(trigger));
  expect(screen.getByRole("complementary", { name: "Work card" })).toBe(card);
});

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

test("the script menu offers only configurations in the checkout", async () => {
  const app = harness();
  const fixture = workCardScenario("worktree");
  app.play(fixture).runUntilBlocked();
  const card = await openWork(app, fixture.thread.id);
  await userEvent.click(within(card).getByRole("button", { name: "Add project script" }));
  await screen.findByRole("menuitem", { name: "Edit package.json scripts" });
  expect(screen.queryByRole("menuitem", { name: "Edit Makefile" })).toBeNull();
  expect(screen.queryByRole("menuitem", { name: "Edit justfile" })).toBeNull();
  expect(screen.queryByRole("menuitem", { name: "Edit Procfile" })).toBeNull();
  await userEvent.click(await screen.findByRole("menuitem", { name: "Edit package.json scripts" }));
  const panel = await screen.findByRole("region", { name: "Thread panel" });
  expect(
    await within(panel).findByRole("tab", { name: /package.json/, selected: true }),
  ).toBeTruthy();
  expect(screen.queryByRole("complementary", { name: "Work card" })).toBeNull();
});

test("a new script file is created, edited and saved through Work", async () => {
  const user = userEvent.setup();
  const app = harness();
  const fixture = workCardScenario("worktree");
  app.play(fixture).runUntilBlocked();
  const card = await openWork(app, fixture.thread.id);
  await user.click(within(card).getByRole("button", { name: "Add project script" }));
  await user.click(await screen.findByRole("menuitem", { name: "New script file…" }));
  const dialog = await screen.findByRole("dialog", { name: "New file" });
  await user.type(within(dialog).getByRole("textbox", { name: "Path" }), "justfile");
  await user.click(within(dialog).getByRole("button", { name: "New file" }));
  const panel = await screen.findByRole("region", { name: "Thread panel" });
  await within(panel).findByRole("tab", { name: "justfile", selected: true });
  await user.click(await within(panel).findByRole("button", { name: "Edit file" }));
  const editor = await within(panel).findByRole("textbox", { name: "Edit justfile" });
  await user.click(editor);
  const script = "check:\n    bun run lint\n";
  await user.paste(script);
  await user.click(within(panel).getByRole("button", { name: "Save" }));
  await waitFor(() =>
    expect(within(panel).queryByRole("textbox", { name: "Edit justfile" })).toBeNull(),
  );
  const chunks: Uint8Array<ArrayBuffer>[] = [];
  for await (const chunk of app.client.downloadFile({
    threadId: ThreadId.parse(fixture.thread.id),
    op: "download",
    path: "justfile",
    offset: 0,
  }))
    chunks.push(new Uint8Array(chunk));
  expect(new TextDecoder().decode(await new Blob(chunks).arrayBuffer())).toBe(script);
  await user.click(screen.getByRole("button", { name: /^Work card/ }));
  await user.click(
    within(await screen.findByRole("complementary", { name: "Work card" })).getByRole("button", {
      name: "Add project script",
    }),
  );
  expect(await screen.findByRole("menuitem", { name: "Edit justfile" })).toBeTruthy();
});

test("the branch menu switches branches without repeating environment actions", async () => {
  const app = harness();
  const fixture = workCardScenario("worktree");
  app.play(fixture).runUntilBlocked();
  const card = await openWork(app, fixture.thread.id);
  await userEvent.click(
    within(card).getByRole("button", { name: "Branch fix/restart-retry, switch branch" }),
  );
  const branch = await screen.findByRole("menuitem", { name: "develop" });
  const menu = screen.getByRole("menu");
  expect(within(menu).queryByRole("menuitem", { name: "Open terminal" })).toBeNull();
  expect(within(menu).queryByRole("menuitem", { name: "Open in…" })).toBeNull();
  expect(within(menu).queryByRole("menuitem", { name: /^Run / })).toBeNull();
  await userEvent.click(branch);
  expect(await screen.findByText("Switched to develop")).toBeTruthy();
  expect(within(card).getByRole("button", { name: "Branch develop, switch branch" })).toBeTruthy();
});
