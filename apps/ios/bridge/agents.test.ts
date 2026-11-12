import { afterEach, describe, expect, test } from "vitest";
import { facts } from "@ace/fake-daemon";
import type { Fact } from "@ace/core";
import { ThreadId } from "@ace/protocol";
import type { AgentSheet } from "@ace/ui-core/mobile";
import "./test-host.ts";
import { followAgents } from "./agents.ts";
import { dispatchCommand } from "./commands.ts";
import { lostChild, plainPreview, RecordingSink, sheetFixture, until } from "./sheet-fixture.ts";

const closers: (() => Promise<void>)[] = [];
afterEach(async () => {
  await Promise.all(closers.splice(0).map((close) => close()));
});

async function opened(threadId: string, seed: Fact[]) {
  const { daemon, client } = sheetFixture();
  closers.push(() => client.close());
  daemon.createThread({ id: threadId, workspaceId: "ace", title: "Tree", provider: "codex" });
  daemon.apply(threadId, seed);
  await client.start();
  const lease = client.thread(threadId);
  await until(() => lease.store.thread !== undefined, "thread snapshot");
  return { daemon, client, store: lease.store };
}
function sheet(sink: RecordingSink): AgentSheet {
  const patch = sink.read("thread:agents");
  expect(patch?.type).toBe("agents.sheet");
  return patch?.sheet as AgentSheet;
}

describe("Agents sheet", () => {
  test("a working subagent keeps the tree unsettled after the root's own turn ended", async () => {
    const { store } = await opened("tree", [
      facts.rootAgent("codex"),
      facts.turn("root"),
      facts.subagent("codex", "reviewer", "Reviewer", "spawn"),
      facts.turn("reviewer", "spawn"),
      facts.endTurn("root"),
    ]);
    const sink = new RecordingSink();
    followAgents(store, "tree", 1, sink, plainPreview);
    await until(() => sheet(sink).rows.length === 2, "both agents");
    const [root, reviewer] = sheet(sink).rows;
    expect(reviewer).toMatchObject({ name: "Reviewer", depth: 1, running: true });
    expect(reviewer?.status).toEqual({ label: "Working", token: "working" });
    // The root's turn is over, but its tree is not: it never reads done.
    expect(root?.depth).toBe(0);
    expect(root?.running).toBe(true);
    expect(root?.status.token).not.toBe("done");
    expect(root?.stoppable).toBe(false);
    expect(reviewer?.stoppable).toBe(true);
    expect(sheet(sink).treeRunning).toBe(true);
  });

  test("background work and usage show beside the tree", async () => {
    const { daemon, store } = await opened("tasks", [
      facts.rootAgent("codex"),
      facts.turn("root"),
      {
        type: "background.started",
        agent: "root",
        task: "watch",
        kind: "shell",
        title: "bun run test --watch",
        stoppable: true,
      },
      { type: "usage", agent: "root", inputTokens: 90_000, outputTokens: 2_000 },
      facts.endTurn("root"),
    ]);
    const sink = new RecordingSink();
    followAgents(store, "tasks", 1, sink, plainPreview);
    await until(() => sheet(sink).tasks.length === 1, "background task");
    expect(sheet(sink).tasks[0]).toMatchObject({
      title: "bun run test --watch",
      stoppable: true,
      status: { label: "running", token: "working" },
    });
    expect(sheet(sink).totals.tokens).toBe(92_000);
    expect(sheet(sink).rows[0]?.running).toBe(true);
    daemon.apply("tasks", [{ type: "background.ended", task: "watch", status: "completed" }]);
    await until(() => sheet(sink).tasks[0]?.status.token === "done", "task ends");
    expect(sheet(sink).tasks[0]?.stoppable).toBe(false);
    expect(sheet(sink).treeRunning).toBe(false);
  });

  test("a large tree shows a page at a time, keeps the working agent first and pages the rest in", async () => {
    const seed: Fact[] = [facts.rootAgent("codex"), facts.turn("root")];
    for (let index = 0; index < 150; index++)
      seed.push(
        facts.subagent("codex", `done-${index}`, `Finished ${index}`, `spawn-${index}`),
        facts.turn(`done-${index}`, "spawn"),
        facts.endTurn(`done-${index}`),
      );
    seed.push(
      facts.subagent("codex", "late", "Still going", "spawn-late"),
      facts.turn("late", "spawn"),
      facts.endTurn("root"),
    );
    const { store } = await opened("big", seed);
    const sink = new RecordingSink();
    const follow = followAgents(store, "big", 1, sink, plainPreview, { agents: 20, tasks: 5 });
    await until(() => sheet(sink).totals.agents === 152, "whole tree");
    const shaped = sheet(sink);
    expect(shaped.rows).toHaveLength(20);
    expect(shaped.hidden).toEqual({ agents: 132, running: 0 });
    expect(shaped.rows.map((row) => row.name)).toContain("Still going");
    expect(shaped.rows[0]?.depth).toBe(0);
    // Stop names only what it would stop: the one subagent still at work, not the 150 that ended.
    expect(shaped.rows[0]?.descendants).toBe(1);
    expect(shaped.totals.running).toBe(2);
    // Show more reads the next page; every agent is reachable on the phone, none left behind.
    follow.more("agents");
    await until(() => sheet(sink).rows.length === 40, "second page");
    expect(sheet(sink).hidden.agents).toBe(112);
    for (let page = 0; page < 6; page++) follow.more("agents");
    await until(() => sheet(sink).hidden.agents === 0, "every page");
    expect(sheet(sink).rows).toHaveLength(152);
    expect(new Set(sheet(sink).rows.map((row) => row.id)).size).toBe(152);
  });

  test("background tasks page in on request, running ones first", async () => {
    const seed: Fact[] = [facts.rootAgent("codex"), facts.turn("root")];
    for (let index = 0; index < 12; index++)
      seed.push(
        {
          type: "background.started",
          agent: "root",
          task: `task-${index}`,
          kind: "shell",
          title: `job ${index}`,
          stoppable: true,
        },
        ...(index === 3
          ? []
          : [
              {
                type: "background.ended" as const,
                task: `task-${index}`,
                status: "completed" as const,
              },
            ]),
      );
    const { store } = await opened("jobs", seed);
    const sink = new RecordingSink();
    const follow = followAgents(store, "jobs", 1, sink, plainPreview, { agents: 20, tasks: 5 });
    await until(() => sheet(sink).tasks.length === 5, "first page of tasks");
    expect(sheet(sink).hiddenTasks).toBe(7);
    expect(sheet(sink).tasks[0]?.title).toBe("job 3");
    follow.more("tasks");
    await until(() => sheet(sink).tasks.length === 10, "second page of tasks");
    follow.more("tasks");
    await until(() => sheet(sink).hiddenTasks === 0, "all tasks");
    expect(sheet(sink).tasks).toHaveLength(12);
  });

  test("streaming transcript text doesn't reshape the tree, and closing stops following", async () => {
    const { daemon, store } = await opened("quiet", [
      facts.rootAgent("codex"),
      facts.turn("root"),
      facts.message("root", "answer", "assistant", "Working on it", false),
    ]);
    const sink = new RecordingSink();
    const follow = followAgents(store, "quiet", 1, sink, plainPreview);
    const before = sink.puts;
    for (let index = 0; index < 20; index++)
      daemon.apply("quiet", [facts.stream("root", "answer", ` more ${index}`)]);
    const streamed = () =>
      store.order.some((id) => JSON.stringify(store.item(id)).includes("more 19"));
    await until(streamed, "deltas land");
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(sink.puts).toBe(before);
    daemon.apply("quiet", [facts.subagent("codex", "helper", "Helper", "spawn")]);
    await until(() => sink.puts > before, "a new agent reshapes");
    follow.stop();
    expect(sink.read("thread:agents")).toBeUndefined();
  });

  test("a failed subagent and a failed task are on the first page, however many others there are", async () => {
    // Created first, so the newest-first tree would put them last.
    const seed: Fact[] = [
      facts.rootAgent("codex"),
      facts.turn("root"),
      facts.subagent("codex", "broken", "Broken", "spawn-broken"),
      facts.turn("broken", "spawn"),
      facts.endTurn("broken", "failed", { kind: "provider", message: "stream closed" }),
      {
        type: "background.started",
        agent: "root",
        task: "lint",
        kind: "shell",
        title: "bun run lint",
        stoppable: true,
      },
      { type: "background.ended", task: "lint", status: "failed" },
    ];
    for (let index = 0; index < 40; index++)
      seed.push(
        facts.subagent("codex", `busy-${index}`, `Busy ${index}`, `spawn-${index}`),
        facts.turn(`busy-${index}`, "spawn"),
        {
          type: "background.started",
          agent: "root",
          task: `done-${index}`,
          kind: "shell",
          title: `step ${index}`,
          stoppable: true,
        },
        { type: "background.ended", task: `done-${index}`, status: "completed" },
      );
    const { store } = await opened("failures", seed);
    const sink = new RecordingSink();
    followAgents(store, "failures", 1, sink, plainPreview, { agents: 10, tasks: 5 });
    await until(() => sheet(sink).totals.agents === 42, "whole tree");
    const shaped = sheet(sink);
    expect(shaped.rows.map((row) => row.name)).toContain("Broken");
    expect(shaped.rows.find((row) => row.name === "Broken")?.status.token).toBe("failed");
    expect(shaped.rows).toHaveLength(10);
    expect(shaped.tasks[0]?.title).toBe("bun run lint");
    expect(shaped.tasks[0]?.status.token).toBe("failed");
  });

  test("an agent waiting on the person is never pushed off the first page by working ones", async () => {
    const seed: Fact[] = [
      facts.rootAgent("codex"),
      facts.turn("root"),
      facts.subagent("codex", "asker", "Asker", "spawn-asker"),
      facts.turn("asker", "spawn"),
      {
        type: "interaction.opened",
        agent: "asker",
        interaction: "ask",
        blocking: true,
        request: {
          kind: "question",
          questions: [
            {
              id: "go",
              text: "Go on?",
              multiSelect: false,
              allowOther: false,
              secret: false,
              options: [
                { id: "yes", label: "Yes" },
                { id: "no", label: "No" },
              ],
            },
          ],
        },
      },
    ];
    for (let index = 0; index < 40; index++)
      seed.push(
        facts.subagent("codex", `busy-${index}`, `Busy ${index}`, `spawn-${index}`),
        facts.turn(`busy-${index}`, "spawn"),
      );
    const { store } = await opened("asking", seed);
    const sink = new RecordingSink();
    followAgents(store, "asking", 1, sink, plainPreview, { agents: 10, tasks: 5 });
    await until(() => sheet(sink).totals.agents === 42, "whole tree");
    const asker = sheet(sink).rows.find((row) => row.name === "Asker");
    expect(asker?.needsYou).toBe(true);
    expect(sheet(sink).rows).toHaveLength(10);
    // The main agent waits on that question: its icon says a question, not an approval.
    expect(sheet(sink).rows[0]?.icon).toMatchObject({ kind: "question", tone: "needs-you" });
    expect(asker?.icon.kind).toBe("question");
  });

  test("the tree's sentence waits on its agents and says who needs the person, never finished early", async () => {
    const { daemon, store } = await opened("sentence", [
      facts.rootAgent("codex"),
      facts.turn("root"),
      facts.subagent("codex", "asker", "Review insets", "spawn-asker"),
      facts.turn("asker", "spawn"),
      facts.subagent("codex", "writer", "Write the test", "spawn-writer"),
      facts.turn("writer", "spawn"),
      {
        type: "interaction.opened",
        agent: "asker",
        interaction: "run",
        blocking: true,
        request: {
          kind: "approval",
          title: "Run bun test?",
          options: [
            { id: "allow", label: "Allow", kind: "allow_once" },
            { id: "deny", label: "Deny", kind: "deny" },
          ],
        },
      },
      facts.endTurn("root"),
    ]);
    const sink = new RecordingSink();
    followAgents(store, "sentence", 1, sink, plainPreview);
    await until(() => sheet(sink).rows.length === 3, "three agents");
    expect(sheet(sink).summary).toEqual({
      text: "Waiting on 2 agents. One needs you.",
      token: "needsYou",
    });
    const asker = sheet(sink).rows.find((row) => row.name === "Review insets");
    expect(asker?.requests).toEqual([...store.interactionIds()]);
    expect(asker?.requests).toHaveLength(1);
    expect(asker?.icon).toMatchObject({ kind: "approve", tone: "needs-you" });
    // The root ended its own turn, but waits on two subagents: its ring counts them.
    expect(sheet(sink).rows[0]?.icon).toMatchObject({ kind: "approve", tone: "needs-you" });
    daemon.apply("sentence", [
      {
        type: "interaction.closed",
        interaction: "run",
        state: "resolved",
        resolution: { kind: "approval", optionId: "allow" },
      },
      facts.endTurn("asker"),
    ]);
    await until(() => sheet(sink).summary.text === "Waiting on 1 agent", "one left");
    expect(sheet(sink).rows[0]?.icon).toEqual({ kind: "agents", tone: "waiting", count: 1 });
    expect(sheet(sink).rows.find((row) => row.name === "Write the test")?.icon.kind).toBe(
      "working",
    );
    daemon.apply("sentence", [facts.endTurn("writer")]);
    await until(() => sheet(sink).summary.token === "done", "all finished");
    expect(sheet(sink).summary.text).toBe("All agents finished");
    expect(sheet(sink).rows.every((row) => row.icon.kind === "done")).toBe(true);
  });

  test("a failed or usage-limited subagent says why on its own line", async () => {
    const { store } = await opened("reasons", [
      facts.rootAgent("codex"),
      facts.turn("root"),
      facts.subagent("codex", "broken", "Check parity", "spawn-broken"),
      facts.turn("broken", "spawn"),
      facts.endTurn("broken", "failed", { kind: "provider", message: "stream closed" }),
      facts.subagent("codex", "held", "Boot the simulator", "spawn-held"),
      facts.turn("held", "spawn"),
      {
        type: "retry",
        agent: "held",
        on: "rate_limit",
        until: Date.UTC(2026, 10, 4, 21, 23),
        message: "Resets soon",
      },
    ]);
    const sink = new RecordingSink();
    followAgents(store, "reasons", 1, sink, plainPreview);
    await until(() => sheet(sink).rows.length === 3, "three agents");
    const broken = sheet(sink).rows.find((row) => row.name === "Check parity");
    expect(broken).toMatchObject({ reason: "stream closed", provider: "codex" });
    expect(broken?.icon.kind).toBe("failed");
    const held = sheet(sink).rows.find((row) => row.name === "Boot the simulator");
    expect(held?.icon).toMatchObject({ kind: "limited", tone: "muted" });
    expect(held?.reason).toMatch(/^out of usage until \d{1,2}:23/);
    // One subagent is still held at its limit, so the tree is not finished.
    expect(sheet(sink).summary.token).not.toBe("done");
  });

  test("a lost child on another machine offers Stop tracking, which answers its parent and leaves the row", async () => {
    const child = "child-a";
    const { agent, facts: lost } = lostChild(child);
    const { daemon, client, store } = await opened("parent", [
      facts.rootAgent("codex"),
      facts.turn("root"),
      ...lost,
    ]);
    // The daemon settles a child the person stopped tracking, as cancelled.
    daemon.onResolved((threadId, key) => {
      if (threadId === "parent" && key === "lost")
        daemon.apply("parent", [
          {
            type: "agent.external",
            agent,
            threadId: ThreadId.parse(child),
            status: { state: "done" },
          },
        ]);
    });
    const sink = new RecordingSink();
    followAgents(store, "parent", 1, sink, plainPreview);
    const row = () => sheet(sink).rows.find((candidate) => candidate.childThreadId === child);
    await until(() => row()?.lost != null, "the lost child's action");
    expect(row()?.needsYou).toBe(true);
    const offer = row()?.lost;
    expect(offer).toMatchObject({
      sentence: "Lost: Studio is no longer paired; its work there may still be running.",
      action: "Stop tracking",
      label: "Stop tracking; its work on Studio may still be running",
    });
    // Only the lost child offers it; the root, which waits on it, doesn't.
    expect(sheet(sink).rows.filter((candidate) => candidate.lost !== null)).toHaveLength(1);
    // Stop tracking goes out as Swift sends it: the parent's request, answered with its option.
    await dispatchCommand(
      client,
      {
        type: "interaction.resolve",
        interactionId: offer?.interactionId,
        resolution: { kind: "approval", optionId: offer?.optionId },
      },
      "stop",
      sink,
    );
    await until(() => daemon.resolution("parent", "lost") !== undefined, "the answer");
    expect(daemon.resolution("parent", "lost")).toEqual({
      kind: "approval",
      optionId: "stop-tracking",
    });
    await until(() => row()?.lost === null && !row()?.needsYou, "the row settles");
    expect(row()?.requests).toEqual([]);
  });
  test("a child on another machine is one row, stopped through the work its parent holds for it", async () => {
    const remote = "ace-child:remote";
    const { store } = await opened("holder", [
      facts.rootAgent("codex"),
      facts.turn("root"),
      {
        type: "agent.seen",
        agent: remote,
        parent: "root",
        origin: "ace",
        fidelity: "summary",
        native: { provider: "claude" },
        cwd: "",
        role: "reviewer",
        machine: { machine: "studio", name: "Studio" },
      },
      {
        type: "agent.external",
        agent: remote,
        threadId: ThreadId.parse("remote"),
        status: { state: "working", agents: 1 },
      },
      {
        type: "background.started",
        owner: "ace",
        agent: "root",
        task: "hold",
        kind: "subagent",
        title: "reviewer · Studio",
        childAgent: remote,
        stoppable: true,
      },
      {
        type: "background.started",
        agent: "root",
        task: "watch",
        kind: "shell",
        title: "bun run test --watch",
        stoppable: true,
      },
    ]);
    const sink = new RecordingSink();
    followAgents(store, "holder", 1, sink, plainPreview);
    await until(() => sheet(sink).rows.length === 2 && sheet(sink).tasks.length > 0, "the tree");
    // The hold is the child's own work: its row stands for it, so it isn't listed again.
    expect(sheet(sink).tasks.map((task) => task.title)).toEqual(["bun run test --watch"]);
    expect(sheet(sink).hiddenTasks).toBe(0);
    const row = sheet(sink).rows.find((candidate) => candidate.machine === "Studio");
    expect(row).toMatchObject({ running: true, stoppable: true });
    expect(row?.holdTaskId).toBeTruthy();
    expect(store.task(row?.holdTaskId ?? "")?.childAgentId).toBe(row?.id);
  });
});
