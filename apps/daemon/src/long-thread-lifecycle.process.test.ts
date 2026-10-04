import { expect, test } from "vitest";
import {
  Agent,
  AgentId,
  Item,
  RunId,
  ThreadId,
  ThreadCatchUpRequest,
  type Thread,
} from "@ace/protocol";
import { createDevThread } from "./commands.ts";
import { fixture as socketFixture } from "./socket-test-support.ts";
import {
  cleanups,
  root,
  storeFixture,
  start,
  end,
  turns,
  catchUp,
  tool,
  agentMessage,
} from "./long-thread-test-support.ts";
import type { Store } from "./store.ts";

function linkedChild(store: Store, parent: Thread, at: number, id = "linked-child") {
  const childRoot = AgentId.parse(`${id}-root`);
  const child = {
    ...parent,
    id: ThreadId.parse(id),
    title: id,
    rootAgentId: childRoot,
    createdAt: at,
    updatedAt: at,
  };
  store.appendEvents(
    child.id,
    [
      { type: "thread.created", thread: child },
      {
        type: "agent.created",
        agent: Agent.parse({
          id: childRoot,
          threadId: child.id,
          parentId: null,
          origin: "root",
          fidelity: "full",
          native: { provider: "codex" },
          cwd: "/repo",
          status: { state: "working", activity: "thinking" },
          createdAt: at,
        }),
      },
      {
        type: "run.started",
        run: {
          id: RunId.parse(`${id}-run`),
          threadId: child.id,
          agentId: childRoot,
          trigger: "spawn",
          state: "active",
          startedAt: at,
        },
      },
      // Core publishes whole-tree status separately from agent/run facts.
      { type: "thread.updated", status: { state: "working", agents: 1 } },
    ],
    at,
  );
  store.appendEvents(
    parent.id,
    [
      {
        type: "agent.created",
        agent: Agent.parse({
          id: `${id}-proxy`,
          threadId: parent.id,
          parentId: root,
          childThreadId: child.id,
          origin: "ace",
          fidelity: "summary",
          native: { provider: "codex" },
          cwd: "/repo",
          status: { state: "idle" },
          createdAt: at,
        }),
      },
    ],
    at,
  );
  return { child, childRoot };
}
function childCommand(id: string, owner: AgentId, command: string) {
  const item = tool(id, "succeeded", { kind: "shell", command, exitCode: 0 });
  if (item.type !== "tool_call") throw new Error("Expected shell item");
  return { ...item, agentId: owner, call: { ...item.call, agentId: owner } };
}

// Mutations: reopening the previous turn or advancing its time/sequence when the root starts
// the next turn. Not executed (tests run at merge).
test("root activity preceding another run cannot change a completed turn's sequence or time", () => {
  const f = storeFixture();
  start(f.store, f.thread, "first", 20);
  end(f.store, f.thread, "first", 30);
  const completed = turns(f.store, f.thread).turns[0];
  if (!completed) throw new Error("Missing completed turn");
  f.store.appendEvents(
    f.thread.id,
    [
      {
        type: "agent.status",
        agentId: root,
        status: { state: "working", activity: "starting_turn" },
      },
    ],
    40,
  );
  expect(turns(f.store, f.thread).turns[0]).toMatchObject({
    endSeq: completed.endSeq,
    endedAt: completed.endedAt,
    outcome: "completed",
  });
  f.store.appendEvents(
    f.thread.id,
    [
      {
        type: "run.started",
        run: {
          id: RunId.parse("second"),
          threadId: f.thread.id,
          agentId: root,
          trigger: "user",
          state: "active",
          startedAt: 50,
        },
      },
    ],
    50,
  );
  const first = turns(f.store, f.thread).turns[0];
  expect(first).toMatchObject({ ordinal: 1, endSeq: completed.endSeq, endedAt: completed.endedAt });
  expect(catchUp(f.store, f.thread, { sinceSeq: completed.endSeq }).turnsCompleted).toBe(0);
});

// Mutations: trusting an idle child proxy, forgetting the original turn when a new ordinal
// starts, failing to settle a parent after child thread completion. Not executed (tests run at merge).
test("linked child status keeps its spawning turn unfinished and settles it during a later root run", () => {
  const f = storeFixture();
  start(f.store, f.thread, "parent-first", 20);
  const { child, childRoot } = linkedChild(f.store, f.thread, 25);
  end(f.store, f.thread, "parent-first", 30);
  expect(turns(f.store, f.thread).turns[0]).toMatchObject({
    outcome: "completed",
    status: { state: "working" },
  });
  expect(turns(f.store, f.thread).turns[0]?.endedAt).toBeUndefined();
  expect(catchUp(f.store, f.thread, { sinceSeq: 0 }).turnsCompleted).toBe(0);
  start(f.store, f.thread, "parent-second", 40);
  expect(turns(f.store, f.thread).turns[0]?.endedAt).toBeUndefined();
  f.store.appendEvents(
    child.id,
    [
      {
        type: "run.ended",
        runId: RunId.parse("linked-child-run"),
        state: "completed",
        endedAt: 50,
      },
      { type: "agent.status", agentId: childRoot, status: { state: "idle" } },
      { type: "thread.updated", status: { state: "done" } },
    ],
    50,
  );
  const [first, second] = turns(f.store, f.thread).turns;
  expect(first).toMatchObject({ ordinal: 1, status: { state: "done" }, endedAt: 50 });
  expect(second).toMatchObject({ ordinal: 2, outcome: "active", status: { state: "working" } });
  expect(catchUp(f.store, f.thread, { sinceSeq: 0 }).turnsCompleted).toBe(1);
});

// Mutations: merging denied child digests into an authorized root response, omitting
// descendant checks on catch-up. Not executed (tests run at merge).
test("wire catch-up refuses a denied descendant before revealing its commands or files", async () => {
  const childId = ThreadId.parse("private-child");
  const f = await socketFixture({ canReadThread: (_device, id) => id !== childId });
  cleanups.push(() => f.close());
  f.store.appendEvents(
    f.thread.id,
    [
      {
        type: "agent.created",
        agent: Agent.parse({
          id: root,
          threadId: f.thread.id,
          parentId: null,
          origin: "root",
          fidelity: "full",
          native: { provider: "codex" },
          cwd: "/repo",
          status: { state: "idle" },
          createdAt: 1,
        }),
      },
    ],
    10,
  );
  start(f.store, f.thread, "parent", 20);
  const { child, childRoot } = linkedChild(f.store, f.thread, 30, "private-child");
  f.store.appendEvents(
    child.id,
    [
      {
        type: "item.created",
        item: childCommand("private-command", childRoot, "secret deployment"),
      },
      {
        type: "item.created",
        item: Item.parse({
          type: "tool_call",
          id: "private-edit",
          agentId: childRoot,
          createdAt: 1,
          complete: true,
          call: {
            id: "private-edit",
            agentId: childRoot,
            kind: "file.write",
            title: "Secret file",
            status: "succeeded",
            startedAt: 1,
            raw: [],
            detail: {
              kind: "file.write",
              changes: [{ path: "private/key.ts", kind: "add", newText: "secret" }],
            },
          },
        }),
      },
    ],
    40,
  );
  const client = await f.connect();
  await client.next();
  client.send(
    ThreadCatchUpRequest.parse({
      type: "thread.catchUp",
      requestId: "private-catch-up",
      threadId: f.thread.id,
      sinceSeq: 0,
    }),
  );
  const denied = await client.next();
  expect(denied).toMatchObject({ type: "error", code: "forbidden", requestId: "private-catch-up" });
  expect(JSON.stringify(denied)).not.toContain("secret deployment");
  expect(JSON.stringify(denied)).not.toContain("private/key.ts");
});

// Mutations: converting sinceTime using only the root event stream, counting an older child
// event whose global sequence is after the root's last event. Not executed (tests run at merge).
test("time-based family catch-up excludes child work before the cutoff even when the root was quiet", () => {
  const f = storeFixture();
  start(f.store, f.thread, "parent", 20);
  const { child, childRoot } = linkedChild(f.store, f.thread, 30);
  f.store.appendEvents(
    child.id,
    [{ type: "item.created", item: childCommand("old-child-command", childRoot, "old work") }],
    80,
  );
  f.store.appendEvents(
    child.id,
    [{ type: "item.created", item: childCommand("new-child-command", childRoot, "new work") }],
    120,
  );
  const summary = catchUp(f.store, f.thread, { sinceTime: 100 });
  expect(summary.digest.commandsRun).toBe(1);
  expect(summary.digest.commands.map((command) => command.command)).toEqual(["new work"]);
  expect(summary.digest.commands.some((command) => command.command === "old work")).toBe(false);
});

// Mutations: leaving the derived index sequence behind a physical retention gap and skipping
// all following appends until restart/backfill. Not executed (tests run at merge).
test("physical thread deletion leaves later canonical writes indexed without daemon restart", () => {
  const f = storeFixture();
  start(f.store, f.thread, "retained", 20);
  const removed = createDevThread(f.store, f.workspace, "Remove this thread");
  f.store.appendEvents(
    removed.id,
    [{ type: "item.created", item: agentMessage("removed-message") }],
    30,
  );
  f.store.deleteThread(removed.id);
  const gap = f.store.headSeq();
  f.store.appendEvents(
    f.thread.id,
    [
      {
        type: "item.created",
        item: tool(
          "after-retention",
          "failed",
          { kind: "shell", command: "after delete", exitCode: 7 },
          "retained",
        ),
      },
    ],
    40,
  );
  const page = turns(f.store, f.thread);
  expect(page.ready).toBe(true);
  expect(page.indexedSeq).toBe(f.store.headSeq());
  expect(page.turns[0]?.digest).toMatchObject({ commandsRun: 1, commandsFailed: 1 });
  expect(
    catchUp(f.store, f.thread, { sinceSeq: gap }).digest.commands.map((command) => command.command),
  ).toEqual(["after delete"]);
});

// Mutations: choosing the greatest turn ordinal rather than the latest assistant item
// sequence. Not executed (tests run at merge).
test("a late assistant message from an earlier turn is the newest catch-up message", () => {
  const f = storeFixture();
  start(f.store, f.thread, "first", 20);
  end(f.store, f.thread, "first", 30);
  start(f.store, f.thread, "second", 40);
  f.store.appendEvents(
    f.thread.id,
    [{ type: "item.created", item: agentMessage("second-reply", "Second turn's reply", "second") }],
    50,
  );
  f.store.appendEvents(
    f.thread.id,
    [
      {
        type: "item.created",
        item: agentMessage(
          "late-first-reply",
          "Late background result from the first turn",
          "first",
        ),
      },
    ],
    60,
  );
  const page = turns(f.store, f.thread);
  expect(page.turns[0]?.latestAgentMessagePreview).toBe(
    "Late background result from the first turn",
  );
  expect(page.turns[1]?.latestAgentMessagePreview).toBe("Second turn's reply");
  expect(catchUp(f.store, f.thread, { sinceSeq: 0 }).latestAgentMessagePreview).toBe(
    "Late background result from the first turn",
  );
});

// Mutations: moving lifetime cumulative usage into the latest turn, resetting the cumulative
// baseline at a turn boundary or summing unchanged samples twice. Not executed (tests run at merge).
test("cumulative usage contributes each turn's new tokens while preserving previous turn totals", () => {
  const f = storeFixture();
  start(f.store, f.thread, "first", 20);
  f.store.appendEvents(
    f.thread.id,
    [
      {
        type: "usage.updated",
        agentId: root,
        inputTokens: 100,
        outputTokens: 20,
        usageScope: "agent",
        counterMode: "cumulative",
        counterKey: "session",
      },
    ],
    25,
  );
  end(f.store, f.thread, "first", 30);
  const boundary = f.store.headSeq();
  start(f.store, f.thread, "second", 40);
  f.store.appendEvents(
    f.thread.id,
    [
      {
        type: "usage.updated",
        agentId: root,
        inputTokens: 150,
        outputTokens: 50,
        usageScope: "agent",
        counterMode: "cumulative",
        counterKey: "session",
      },
      {
        type: "usage.updated",
        agentId: root,
        inputTokens: 150,
        outputTokens: 50,
        usageScope: "agent",
        counterMode: "cumulative",
        counterKey: "session",
      },
    ],
    50,
  );
  const [first, second] = turns(f.store, f.thread).turns;
  expect(first?.digest).toMatchObject({ inputTokens: 100, outputTokens: 20 });
  expect(second?.digest).toMatchObject({ inputTokens: 50, outputTokens: 30 });
  expect(catchUp(f.store, f.thread, { sinceSeq: 0 }).digest).toMatchObject({
    inputTokens: 150,
    outputTokens: 50,
  });
  expect(catchUp(f.store, f.thread, { sinceSeq: boundary }).digest).toMatchObject({
    inputTokens: 50,
    outputTokens: 30,
  });
});
