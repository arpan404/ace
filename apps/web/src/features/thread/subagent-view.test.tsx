import type { Fact } from "@ace/core";
import { coldStartReplay, delegatedDocs, delegatedDocsIds, facts } from "@ace/fake-daemon";
import { ThreadId } from "@ace/protocol";
import { createMemoryHistory } from "@tanstack/react-router";
import { act, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, test } from "vitest";
import { harness } from "@/test/harness.tsx";
import { openWorkCard } from "@/test/open-work.ts";

beforeEach(() => localStorage.clear());

const parentTitle = "Cap cold-start replay at 200 events";

/** Opens the transcript's subagent card and follows the named subagent's row. */
async function openFromCard(title: string, row: RegExp) {
  const feed = await screen.findByRole("feed", { name: "Transcript" });
  const card = await within(feed).findByRole("region", { name: title });
  await userEvent.click(within(card).getByRole("button", { name: title }));
  await userEvent.click(within(card).getByRole("link", { name: row }));
}

test("opening a subagent from its card shows its own transcript as the whole chat, and Back returns to the parent", async () => {
  const history = createMemoryHistory({ initialEntries: ["/t/thread-cold-start"] });
  const app = harness({ history });
  app.play(coldStartReplay()).runThrough("audit-done");
  await app.open("/t/thread-cold-start");
  await screen.findByRole("heading", { level: 1, name: parentTitle });

  await openFromCard("2 subagents", /^Open resume-sweep,/);

  await screen.findByRole("heading", { level: 1, name: "resume-sweep" });
  expect(history.location.pathname).toMatch(/^\/t\/thread-cold-start\/agents\/.+/);
  // What its parent asked it opens the chat, then only its own work, never its parent's.
  expect(screen.getByText("Sweep the web and mobile resume callers")).toBeTruthy();
  const transcript = screen.getByRole("feed", { name: "Transcript" });
  expect(within(transcript).getByText(/Three callers resume from seq 0/)).toBeTruthy();
  expect(within(transcript).queryByText(/replayFrom now treats seq 0/)).toBeNull();
  // The header reads `parent / subagent`, with the parent a link back.
  expect(within(screen.getByRole("banner")).getByRole("link", { name: parentTitle })).toBeTruthy();
  // Nobody can message a provider's own subagent, so no composer stands at the bottom.
  expect(screen.queryByRole("combobox", { name: "Message" })).toBeNull();

  act(() => history.back());
  await screen.findByRole("heading", { level: 1, name: parentTitle });
  expect(history.location.pathname).toBe("/t/thread-cold-start");
  act(() => history.forward());
  await screen.findByRole("heading", { level: 1, name: "resume-sweep" });
});

const spawnReviewer: Fact[] = [
  facts.tool("root", "spawn-reviewer", {
    kind: "agent.spawn",
    title: "Review the changes",
    detail: { kind: "agent.spawn", description: "Review the diff", childAgent: "reviewer" },
  }),
  facts.subagent("claude", "reviewer", "Reviewer", "spawn-reviewer"),
  facts.turn("reviewer", "spawn"),
  facts.tool("reviewer", "read", {
    kind: "file.read",
    title: "Read config",
    detail: { kind: "file.read", path: "config.ts" },
  }),
];

test("a finished subagent shows the bar with how long it ran and Open parent instead of a composer", async () => {
  let now = 1_000;
  const app = harness({ clock: () => now, uiClock: () => now });
  app.daemon.createThread({
    id: "timed-review",
    workspaceId: "relay",
    provider: "claude",
    title: "Review changes",
  });
  app.daemon.apply("timed-review", [
    facts.rootAgent("claude"),
    facts.turn("root"),
    ...spawnReviewer,
  ]);
  await app.open("/t/timed-review");
  await openFromCard("1 subagent", /^Open Reviewer,/);
  await screen.findByRole("heading", { level: 1, name: "Reviewer" });
  const bar = screen.getByRole("group", { name: "Subagent" });
  expect(within(bar).getByText(/^Working for/)).toBeTruthy();
  expect(within(bar).queryByText(/^Completed/)).toBeNull();

  now += 345_000;
  act(() =>
    app.daemon.apply("timed-review", [
      facts.toolDone("reviewer", "read"),
      facts.endTurn("reviewer"),
    ]),
  );
  expect(await within(bar).findByText("Completed in 5m 45s")).toBeTruthy();
  expect(within(bar).getByText("Runs on its own")).toBeTruthy();
  expect(within(bar).queryByRole("button", { name: /^Stop/ })).toBeNull();
  expect(screen.queryByRole("combobox", { name: "Message" })).toBeNull();

  await userEvent.click(within(bar).getByRole("link", { name: "Open parent" }));
  await screen.findByRole("heading", { level: 1, name: "Review changes" });
});

const pending: { name: string; facts: Fact[]; settle: Fact[]; says: RegExp }[] = [
  {
    name: "child still works",
    facts: [
      facts.subagent("claude", "child", "Child", "spawn-child", { parent: "reviewer" }),
      facts.turn("child"),
    ],
    settle: [facts.endTurn("child")],
    says: /^Working for/,
  },
  {
    name: "background shell still runs",
    facts: [
      {
        type: "background.started",
        agent: "reviewer",
        task: "watch",
        kind: "shell",
        title: "Watch build",
        ambient: true,
        stoppable: true,
      },
    ],
    settle: [{ type: "background.ended", task: "watch", status: "completed" }],
    says: /^Working for/,
  },
  {
    name: "question waits on the person",
    facts: [
      {
        type: "interaction.opened",
        agent: "reviewer",
        interaction: "question",
        blocking: false,
        request: { kind: "question", questions: [] },
      },
    ],
    settle: [{ type: "interaction.closed", interaction: "question", state: "resolved" }],
    says: /^Waiting on you$/,
  },
];

test.each(pending)(
  "a subagent whose own turn ended never says Completed while its $name",
  async (work) => {
    const app = harness({ uiClock: () => 2_000 });
    app.daemon.createThread({
      id: "branch-review",
      workspaceId: "relay",
      provider: "claude",
      title: "Branch review",
    });
    app.daemon.apply("branch-review", [
      facts.rootAgent("claude"),
      facts.turn("root"),
      ...spawnReviewer,
      ...work.facts,
      facts.toolDone("reviewer", "read"),
      facts.endTurn("reviewer"),
    ]);
    await app.open("/t/branch-review");
    await openFromCard("1 subagent", /^Open Reviewer,/);
    const bar = await screen.findByRole("group", { name: "Subagent" });
    expect(await within(bar).findByText(work.says)).toBeTruthy();
    expect(within(bar).queryByText(/^Completed/)).toBeNull();
    expect(within(bar).getByRole("button", { name: /^Stop Reviewer/ })).toBeTruthy();

    act(() => app.daemon.apply("branch-review", work.settle));
    expect(await within(bar).findByText(/^Completed in/)).toBeTruthy();
    expect(within(bar).queryByRole("button", { name: /^Stop Reviewer/ })).toBeNull();
  },
);

test("Stop in a running subagent's bar stops it, and the bar says when it stopped", async () => {
  const app = harness();
  app.daemon.createThread({
    id: "stop-review",
    workspaceId: "relay",
    provider: "claude",
    title: "Stop review",
  });
  app.daemon.apply("stop-review", [
    facts.rootAgent("claude"),
    facts.turn("root"),
    ...spawnReviewer,
  ]);
  await app.open("/t/stop-review");
  await openFromCard("1 subagent", /^Open Reviewer,/);
  const bar = await screen.findByRole("group", { name: "Subagent" });
  await userEvent.click(within(bar).getByRole("button", { name: "Stop Reviewer" }));
  expect(await within(bar).findByText(/^Stopped after/)).toBeTruthy();
});

test("a running thread ace delegated keeps the composer, since ace delivers messages to it", async () => {
  const app = harness();
  app.daemon.createThread({
    id: "docs-parent",
    workspaceId: "relay",
    provider: "claude",
    title: "Relay docs",
  });
  app.daemon.apply("docs-parent", [facts.rootAgent("claude"), facts.turn("root")]);
  app.daemon.createThread({
    id: "docs-child",
    workspaceId: "relay",
    provider: "codex",
    title: "Relay protocol reference",
    parentThreadId: "docs-parent",
  });
  app.daemon.apply("docs-child", [
    facts.rootAgent("codex"),
    facts.turn("root", "spawn"),
    {
      type: "item.upsert",
      agent: "root",
      item: "ask",
      draft: {
        type: "message",
        role: "user",
        complete: true,
        parts: [{ type: "text", text: "Write docs/protocol/relay.md" }],
        origin: { kind: "spawn", parentThreadId: ThreadId.parse("docs-parent") },
      },
    },
  ]);
  await app.open("/t/docs-child");
  await screen.findByRole("heading", { level: 1, name: "Relay protocol reference" });
  expect(
    await within(screen.getByRole("banner")).findByRole("link", { name: "Relay docs" }),
  ).toBeTruthy();
  expect(screen.queryByRole("group", { name: "Subagent" })).toBeNull();
  await userEvent.type(
    await screen.findByRole("combobox", { name: "Message" }),
    "Add a table of close codes too.{Enter}",
  );
  // Delivered to the delegated thread: queued or steered into its turn, either way shown there.
  expect((await screen.findAllByText("Add a table of close codes too.")).length).toBeGreaterThan(0);
});

test("a finished thread ace delegated shows the bar with its model, effort and duration, and Open parent", async () => {
  const app = harness({ clock: () => 10 * 60_000 });
  for (const scenario of delegatedDocs()) app.play(scenario).runUntilBlocked();
  await app.open(`/t/${delegatedDocsIds.child}`);
  await screen.findByRole("heading", { level: 1, name: "Relay protocol reference" });
  const bar = await screen.findByRole("group", { name: "Subagent" });
  expect(within(bar).getByText("High")).toBeTruthy();
  expect(await within(bar).findByText("Completed in 5m 45s")).toBeTruthy();
  expect(within(bar).getByText("Delegated by ace")).toBeTruthy();
  expect(screen.queryByRole("combobox", { name: "Message" })).toBeNull();

  await userEvent.click(within(bar).getByRole("link", { name: "Open parent" }));
  await screen.findByRole("heading", { level: 1, name: "Relay docs for 0.9" });
});

test("the details card's Lineage names a subagent's parent with its status and its siblings", async () => {
  const app = harness();
  app.play(coldStartReplay()).runThrough("audit-done");
  await app.open("/t/thread-cold-start");
  await openFromCard("2 subagents", /^Open resume-sweep,/);
  await screen.findByRole("heading", { level: 1, name: "resume-sweep" });
  const card = await openWorkCard();
  const lineage = await within(card).findByRole("region", { name: "Lineage" });
  expect(
    within(lineage).getByRole("button", { name: new RegExp(`^Open parent ${parentTitle}, `) }),
  ).toBeTruthy();
  // The one on screen is marked, not offered as somewhere to go.
  expect(within(lineage).getByRole("group", { name: /^resume-sweep, Done, shown$/ })).toBeTruthy();

  await userEvent.click(within(lineage).getByRole("button", { name: /^Open ack-buffer-test, / }));
  await screen.findByRole("heading", { level: 1, name: "ack-buffer-test" });
});

test("a running subagent's transcript ends with the live line: how long it has worked and its step", async () => {
  const app = harness({ uiClock: () => 61_000 });
  app.daemon.createThread({
    id: "live-review",
    workspaceId: "relay",
    provider: "claude",
    title: "Live review",
  });
  app.daemon.apply("live-review", [
    facts.rootAgent("claude"),
    facts.turn("root"),
    ...spawnReviewer,
  ]);
  await app.open("/t/live-review");
  await openFromCard("1 subagent", /^Open Reviewer,/);
  await screen.findByRole("heading", { level: 1, name: "Reviewer" });
  const line = await screen.findByRole("status", { name: "Working" });
  expect(line.textContent).toMatch(/^Working for \d/);
  expect(line.textContent).toContain("Read config");
});

test("a finished thread ace delegated can be continued: Continue brings its composer back", async () => {
  const app = harness({ clock: () => 10 * 60_000 });
  for (const scenario of delegatedDocs()) app.play(scenario).runUntilBlocked();
  await app.open(`/t/${delegatedDocsIds.child}`);
  const bar = await screen.findByRole("group", { name: "Subagent" });
  expect(screen.queryByRole("combobox", { name: "Message" })).toBeNull();
  await userEvent.click(within(bar).getByRole("button", { name: "Continue" }));
  await userEvent.type(
    await screen.findByRole("combobox", { name: "Message" }),
    "Add a table of close codes too.{Enter}",
  );
  expect((await screen.findAllByText("Add a table of close codes too.")).length).toBeGreaterThan(0);
});

test("a long delegated thread still names its parent when its launch message isn't loaded", async () => {
  const app = harness({ snapshotItems: 5 });
  app.daemon.createThread({
    id: "long-parent",
    workspaceId: "relay",
    provider: "claude",
    title: "Long parent",
  });
  app.daemon.apply("long-parent", [facts.rootAgent("claude"), facts.turn("root")]);
  app.daemon.createThread({
    id: "long-child",
    workspaceId: "relay",
    provider: "codex",
    title: "Long delegated work",
    parentThreadId: "long-parent",
  });
  app.daemon.apply("long-child", [
    facts.rootAgent("codex"),
    facts.turn("root", "spawn"),
    ...Array.from({ length: 40 }, (_, at) =>
      facts.message("root", `note-${at}`, "assistant", `Progress note ${at}`),
    ),
  ]);
  await app.open("/t/long-child");
  await screen.findByRole("heading", { level: 1, name: "Long delegated work" });
  expect(
    await within(screen.getByRole("banner")).findByRole("link", { name: "Long parent" }),
  ).toBeTruthy();
  const card = await openWorkCard();
  expect(
    within(await within(card).findByRole("region", { name: "Lineage" })).getByRole("button", {
      name: /^Open parent Long parent/,
    }),
  ).toBeTruthy();
});
