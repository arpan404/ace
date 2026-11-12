import {
  agentTree,
  gitAction,
  machineRow,
  agentRow,
  isBreathing,
  openWorkCard,
  openWorkPanel,
} from "@/test/open-work.ts";
import { facts, workCardScenario } from "@ace/fake-daemon";
import { Automation, ThreadId } from "@ace/protocol";
import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, test } from "vitest";
import { harness } from "@/test/harness.tsx";

beforeEach(() => localStorage.clear());

async function openWork(app: ReturnType<typeof harness>, threadId: string) {
  await app.open(`/t/${threadId}`);
  await openWorkPanel();
  return screen.findByRole("tabpanel", { name: "Summary" });
}

/** Open the details card on `threadId` from the header's details icon. */
async function openCard(app: ReturnType<typeof harness>, threadId: string) {
  await app.open(`/t/${threadId}`);
  return openWorkCard();
}

/** The card's Add project script menu: the checkout's script files and a new one. */
async function openScripts() {
  const card = await openWorkCard();
  await userEvent.click(within(card).getByRole("button", { name: "Add project script" }));
  return screen.findByRole("menu");
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
              secret: false,
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
  // A question the agent can work past doesn't ask for the person yet.
  expect(card.querySelector("[data-tone=needs-you]")).toBeNull();
  expect(
    within(screen.getByRole("banner")).queryByRole("button", {
      name: "Thread details, something needs you",
    }),
  ).toBeNull();
  act(() => app.daemon.apply(fixture.thread.id, [facts.endTurn("worker-1")]));
  // A subagent's ask leads Still running, in the needs-you colour, with Open to it.
  const live = await within(card).findByRole("region", { name: "Still running" });
  await waitFor(() =>
    expect(within(live).getAllByRole("button")[0]?.getAttribute("aria-label")).toBe(
      "Check supervisor logs: asks: Which cases?",
    ),
  );
  expect(within(live).getByRole("button", { name: "Open Check supervisor logs" })).toBeTruthy();
  const asker = await agentRow(card, "Check supervisor logs");
  expect(asker.getAttribute("aria-label")).toBe("Check supervisor logs: asks: Which cases?");
  expect(asker.querySelector("[data-tone=needs-you]")).toBeTruthy();
  // Its parents wait on it: they stay live and say so in grey, not as a second request.
  expect(isBreathing(await agentRow(card, "Codex"))).toBe(true);
});

test.each(["completed", "interrupted"] as const)(
  "a parent with a %s turn describes its active subtree",
  async (outcome) => {
    const app = harness();
    const fixture = workCardScenario("changes");
    app.play(fixture).runUntilBlocked();
    const work = await openWork(app, fixture.thread.id);
    act(() => app.daemon.apply(fixture.thread.id, [facts.endTurn("worker-0", outcome)]));
    await waitFor(async () =>
      expect((await agentRow(work, "Write retry tests")).getAttribute("aria-label")).toMatch(
        /^Write retry tests: waiting /,
      ),
    );
    expect(isBreathing(await agentRow(work, "Write retry tests"))).toBe(true);
  },
);

test("Escape from the machine menu restores focus to its row and keeps the card open", async () => {
  const app = harness();
  const fixture = workCardScenario("worktree");
  app.play(fixture).runUntilBlocked();
  const card = await openCard(app, fixture.thread.id);
  const trigger = within(card).getByRole("button", { name: machineRow });
  act(() => trigger.focus());
  await userEvent.keyboard("{Enter}");
  await screen.findByRole("menu");
  await userEvent.keyboard("{Escape}");
  await waitFor(() => expect(document.activeElement).toBe(trigger));
  expect(screen.getByRole("dialog", { name: "Thread details" })).toBe(card);
});

test("a retrying child remains active while it waits on its provider", async () => {
  const app = harness();
  const fixture = workCardScenario("changes");
  app.play(fixture).runUntilBlocked();
  const work = await openWork(app, fixture.thread.id);
  act(() =>
    app.daemon.apply(fixture.thread.id, [{ type: "retry", agent: "worker-0", on: "rate_limit" }]),
  );
  await waitFor(async () =>
    expect((await agentRow(work, "Write retry tests")).getAttribute("aria-label")).toMatch(
      /rate limit/,
    ),
  );
  expect(isBreathing(await agentRow(work, "Write retry tests"))).toBe(true);
});

test("a failed child opens its own work without leaking its raw error into the tree", async () => {
  const app = harness();
  const fixture = workCardScenario("failed");
  app.play(fixture).runUntilBlocked();
  const work = await openWork(app, fixture.thread.id);
  // The tree only says that it failed, in red, not why: opening the row shows the error.
  const tree = await agentTree(work);
  expect(within(tree).queryByText("The test command failed. Check its output.")).toBeNull();
  const failed = await agentRow(work, "Check supervisor logs");
  expect(failed.getAttribute("aria-label")).toBe("Check supervisor logs: couldn't finish");
  expect(failed.querySelector("[data-tone=failed]")).toBeTruthy();
  await userEvent.click(failed);
  // A subagent opens as the whole chat (042b898e3).
  expect(
    await screen.findByRole("heading", { level: 1, name: /Check supervisor logs/ }),
  ).toBeTruthy();
});

test("an ended parent remains active until its nested child settles", async () => {
  const app = harness();
  const fixture = workCardScenario("changes");
  app.play(fixture).runUntilBlocked();
  const work = await openWork(app, fixture.thread.id);
  act(() => app.daemon.apply(fixture.thread.id, [facts.endTurn("worker-0")]));
  await waitFor(async () =>
    expect((await agentRow(work, "Write retry tests")).getAttribute("aria-label")).toMatch(
      /: waiting /,
    ),
  );
  // Its own turn ended, but its subagent still works: it never reads done.
  expect(isBreathing(await agentRow(work, "Write retry tests"))).toBe(true);
  act(() => app.daemon.apply(fixture.thread.id, [facts.endTurn("worker-1")]));
  // Both subagents settled: it joins the finished reader in one done line (ADR 0108), while the
  // main agent still waits on its background command.
  await userEvent.click(await within(work).findByRole("treeitem", { name: "2 done" }));
  const settled = await agentRow(work, "Write retry tests");
  expect(isBreathing(settled)).toBe(false);
  // The settled branch folds and says what it holds.
  expect(settled.getAttribute("aria-label")).toMatch(/ · 1 done$/);
  expect(isBreathing(await agentRow(work, "Codex"))).toBe(true);
});

test("the project's schedules read as one line at the foot of the Summary that opens them", async () => {
  // Midday UTC, so the next run is "Today" whatever time the suite runs (at 18:00 it reads "Tonight").
  const now = Date.UTC(2026, 5, 10, 12, 0);
  const app = harness({ clock: () => now, uiClock: () => now });
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
        startAt: now - 60_000,
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
  // One quiet line: this project's schedules only, and when the next one runs.
  const line = await within(card).findByRole("button", { name: /automation in this project/ });
  expect(line.textContent).toMatch(/^1 automation in this project · next today /);
  await userEvent.click(line);
  expect(await screen.findByRole("complementary", { name: "Automations" })).toBeTruthy();
});

test("push waits for confirmation and cancellation leaves the branch unchanged", async () => {
  const app = harness();
  const fixture = workCardScenario("worktree");
  fixture.thread.details = { ...fixture.thread.details, ahead: 1 };
  app.play(fixture).runUntilBlocked();
  await openCard(app, fixture.thread.id);
  const ahead = () => {
    const snapshot = app.daemon.snapshot({
      kind: "thread",
      threadId: ThreadId.parse(fixture.thread.id),
    });
    return snapshot && "thread" in snapshot ? snapshot.thread.details?.ahead : undefined;
  };
  await gitAction("Push");
  const confirm = await screen.findByRole("dialog", { name: "Push fix/restart-retry?" });
  expect(ahead()).toBe(1);
  await userEvent.click(within(confirm).getByRole("button", { name: "Cancel" }));
  expect(ahead()).toBe(1);
  await gitAction("Push");
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
  await openCard(app, fixture.thread.id);
  await openScripts();
  await screen.findByRole("menuitem", { name: "Edit package.json scripts" });
  expect(screen.queryByRole("menuitem", { name: "Edit Makefile" })).toBeNull();
  expect(screen.queryByRole("menuitem", { name: "Edit justfile" })).toBeNull();
  expect(screen.queryByRole("menuitem", { name: "Edit Procfile" })).toBeNull();
  await userEvent.click(await screen.findByRole("menuitem", { name: "Edit package.json scripts" }));
  const panel = await screen.findByRole("region", { name: "Thread panel" });
  expect(
    await within(panel).findByRole("tab", { name: /package.json/, selected: true }),
  ).toBeTruthy();
  await waitFor(() => expect(screen.queryByRole("dialog", { name: "Thread details" })).toBeNull());
});

test("a new script file is created, edited and saved through the details card", async () => {
  const user = userEvent.setup();
  const app = harness();
  const fixture = workCardScenario("worktree");
  app.play(fixture).runUntilBlocked();
  await openCard(app, fixture.thread.id);
  await openScripts();
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
  await openScripts();
  expect(await screen.findByRole("menuitem", { name: "Edit justfile" })).toBeTruthy();
});

test("the branch menu switches branches without repeating environment actions", async () => {
  const app = harness();
  const fixture = workCardScenario("worktree");
  app.play(fixture).runUntilBlocked();
  const card = await openCard(app, fixture.thread.id);
  await userEvent.click(
    within(card).getByRole("button", { name: "Branch fix/restart-retry, switch branch" }),
  );
  const branch = await screen.findByRole("menuitem", { name: "develop" });
  const menu = screen.getByRole("menu");
  expect(within(menu).queryByRole("menuitem", { name: "Open terminal" })).toBeNull();
  expect(within(menu).queryByRole("menuitem", { name: /^Copy path/ })).toBeNull();
  expect(within(menu).queryByRole("menuitem", { name: /^Run / })).toBeNull();
  await userEvent.click(branch);
  expect(
    await within(await openWorkCard()).findByRole("button", {
      name: "Branch develop, switch branch",
    }),
  ).toBeTruthy();
});
