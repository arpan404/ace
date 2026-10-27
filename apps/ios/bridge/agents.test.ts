import { afterEach, describe, expect, test } from "vitest";
import { facts } from "@ace/fake-daemon";
import type { Fact } from "@ace/core";
import type { AgentSheet } from "@ace/ui-core/mobile";
import { followAgents } from "./agents.ts";
import { plainPreview, RecordingSink, sheetFixture, until } from "./sheet-fixture.ts";

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
  return { daemon, store: lease.store };
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
    expect(shaped.rows[0]?.descendants).toBe(151);
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
});
