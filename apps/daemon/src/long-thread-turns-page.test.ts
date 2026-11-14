import { expect, test } from "vitest";
import { Agent, AgentId, RunId, ThreadId, type Thread } from "@ace/protocol";
import {
  agentMessage,
  end,
  root,
  start,
  storeFixture,
  tool,
  turns,
  userMessage,
} from "./long-thread-test-support.ts";
import type { Store } from "./store.ts";

function owned(id: string, owner: AgentId, detail: Parameters<typeof tool>[2]) {
  const item = tool(id, "succeeded", detail);
  if (item.type !== "tool_call") throw new Error("Expected a tool call");
  return { ...item, agentId: owner, call: { ...item.call, agentId: owner } };
}
const shell = (command: string) => ({ kind: "shell" as const, command, exitCode: 0 });
const edit = (path: string) => ({
  kind: "file.edit" as const,
  changes: [{ path, kind: "update" as const, diff: "@@ -1 +1,2 @@\n-a\n+b\n+c\n" }],
});

function subagent(thread: Thread, id: string, at: number, childThreadId?: ThreadId) {
  return {
    type: "agent.created" as const,
    agent: Agent.parse({
      id,
      threadId: thread.id,
      parentId: root,
      ...(childThreadId ? { childThreadId } : {}),
      origin: childThreadId ? "ace" : "provider_subagent",
      fidelity: childThreadId ? "summary" : "full",
      native: { provider: "codex" },
      cwd: "/repo",
      status: { state: "idle" },
      createdAt: at,
    }),
  };
}

/** A child thread of its own, with one command its root agent ran. */
function childThread(store: Store, parent: Thread, at: number) {
  const childRoot = AgentId.parse("child-root");
  const child = { ...parent, id: ThreadId.parse("child"), title: "child", rootAgentId: childRoot };
  store.appendEvents(child.id, [
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
        status: { state: "idle" },
        createdAt: at,
      }),
    },
    {
      type: "run.started",
      run: {
        id: RunId.parse("child-run"),
        threadId: child.id,
        agentId: childRoot,
        trigger: "spawn",
        state: "active",
        startedAt: at,
      },
    },
    { type: "item.created", item: owned("child-command", childRoot, shell("child test")) },
    { type: "run.ended", runId: RunId.parse("child-run"), state: "completed", endedAt: at + 1 },
  ]);
  return child.id;
}

const paths = (digest: { files: { path: string }[] }) => digest.files.map((file) => file.path);
const commands = (digest: { commands: { command: string }[] }) =>
  digest.commands.map((command) => command.command);

/** Three turns; the middle one has the main agent's work, an inline subagent and a child thread. */
function seed() {
  const f = storeFixture();
  const { store, thread } = f;
  for (const [index, at] of [10, 20, 40].entries()) {
    const run = `run-${index}`;
    store.appendEvents(thread.id, [
      { type: "item.created", item: userMessage(`ask-${index}`, `ask ${index}`) },
    ]);
    start(store, thread, run, at);
    store.appendEvents(thread.id, [
      { type: "item.created", item: owned(`main-edit-${index}`, root, edit(`main-${index}.ts`)) },
      { type: "item.created", item: owned(`main-run-${index}`, root, shell(`make ${index}`)) },
    ]);
    if (index === 1) {
      const sub = AgentId.parse("inline-sub");
      const child = childThread(store, thread, at + 1);
      store.appendEvents(thread.id, [
        subagent(thread, sub, at + 1),
        { type: "item.created", item: owned("sub-edit", sub, edit("sub.ts")) },
        { type: "item.created", item: owned("sub-run", sub, shell("lint")) },
        subagent(thread, "linked", at + 2, child),
      ]);
    }
    store.appendEvents(thread.id, [
      { type: "item.created", item: agentMessage(`answer-${index}`, `answer ${index}`) },
    ]);
    end(store, thread, run, at + 5);
  }
  return f;
}

test("a page of turns reads each turn the same as a page holding that turn alone", () => {
  const { store, thread } = seed();
  const page = turns(store, thread);
  expect(page.turns.map((turn) => [turn.ordinal, turn.initiatingMessagePreview])).toEqual([
    [1, "ask 0"],
    [2, "ask 1"],
    [3, "ask 2"],
  ]);
  const alone = page.turns.map(
    (turn) => turns(store, thread, { before: turn.ordinal + 1, limit: 1 }).turns[0],
  );
  expect(page.turns).toEqual(alone);
  expect(turns(store, thread, { after: 1, limit: 2 }).turns).toEqual(page.turns.slice(1));
});

test("a turn credits each file and command to the agent that made it", () => {
  const { store, thread } = seed();
  const turn = turns(store, thread).turns[1];
  if (!turn) throw new Error("Missing turn");
  expect(paths(turn.digest).toSorted()).toEqual(["main-1.ts", "sub.ts"]);
  expect(commands(turn.digest).toSorted()).toEqual(["lint", "make 1"]);
  expect(turn.main).toMatchObject({ agentId: root });
  expect(paths(turn.main?.digest ?? { files: [] })).toEqual(["main-1.ts"]);
  expect(commands(turn.main?.digest ?? { commands: [] })).toEqual(["make 1"]);
  const inline = turn.subagents.find((agent) => agent.agentId === "inline-sub");
  expect(inline && paths(inline.digest)).toEqual(["sub.ts"]);
  expect(inline && commands(inline.digest)).toEqual(["lint"]);
  // A subagent with a thread of its own is summarised from that thread.
  const linked = turn.subagents.find((agent) => agent.agentId === "linked");
  expect(linked?.threadId).toBe("child");
  expect(linked && commands(linked.digest)).toEqual(["child test"]);
  expect(turns(store, thread).turns[0]?.subagents).toEqual([]);
});
