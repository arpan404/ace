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

test("index rows an older build left are validated, never sent as stored", async () => {
  const f = seed();
  // An older build's index: commands and agent statuses carrying a field this schema doesn't have.
  f.store.atomic((db) =>
    db.exec(
      `UPDATE long_commands SET data = json_set(data, '$.legacy', 1);
       UPDATE long_agents SET status = json_set(status, '$.legacy', 1);`,
    ),
  );
  await f.restart();
  const page = turns(f.store, f.thread);
  expect(JSON.stringify(page)).not.toContain("legacy");
  expect(commands(page.turns[1]?.digest ?? { commands: [] }).toSorted()).toEqual([
    "lint",
    "make 1",
  ]);
  // A status no variant of this schema accepts fails the read instead of reaching a client.
  f.store.atomic((db) =>
    db.exec(`UPDATE long_agents SET status = '{"state":"retired"}' WHERE id = 'inline-sub'`),
  );
  await f.restart();
  expect(() => turns(f.store, f.thread)).toThrow();
});

test("a turn with more than 64 files or commands shows 64 of each and says it was cut", () => {
  const f = storeFixture();
  const { store, thread } = f;
  const sub = AgentId.parse("busy-sub");
  store.appendEvents(thread.id, [{ type: "item.created", item: userMessage("ask-busy") }]);
  start(store, thread, "busy", 10);
  store.appendEvents(thread.id, [subagent(thread, sub, 11)]);
  for (let index = 0; index < 70; index++)
    store.appendEvents(thread.id, [
      { type: "item.created", item: owned(`edit-${index}`, root, edit(`main/${index}.ts`)) },
      { type: "item.created", item: owned(`run-${index}`, root, shell(`step ${index}`)) },
      { type: "item.created", item: owned(`sub-edit-${index}`, sub, edit(`sub/${index}.ts`)) },
      { type: "item.created", item: owned(`sub-run-${index}`, sub, shell(`sub ${index}`)) },
    ]);
  end(store, thread, "busy", 20);
  store.appendEvents(thread.id, [{ type: "item.created", item: userMessage("ask-small") }]);
  start(store, thread, "small", 30);
  store.appendEvents(thread.id, [
    { type: "item.created", item: owned("small-run", root, shell("small")) },
  ]);
  end(store, thread, "small", 40);

  const [busy, small] = turns(store, thread).turns;
  if (!busy || !small) throw new Error("Missing turns");
  expect(busy.digest).toMatchObject({ commandsRun: 140, truncated: true });
  expect([busy.digest.files.length, busy.digest.commands.length]).toEqual([64, 64]);
  const shares = [busy.main?.digest, busy.subagents[0]?.digest];
  for (const share of shares) {
    expect(share).toMatchObject({ commandsRun: 70, truncated: true });
    expect([share?.files.length, share?.commands.length]).toEqual([64, 64]);
  }
  expect(paths(shares[1] ?? { files: [] }).every((path) => path.startsWith("sub/"))).toBe(true);
  expect(small.digest).toMatchObject({ commandsRun: 1, truncated: false });
  expect(commands(small.digest)).toEqual(["small"]);
  expect(turns(store, thread, { before: 2, limit: 1 }).turns).toEqual([busy]);
});

/** The page after `sql` rewrites the index as an older build might have left it. */
async function pageAfter(sql: string) {
  const f = seed();
  f.store.atomic((db) => db.exec(sql));
  await f.restart();
  return () => turns(f.store, f.thread);
}

test("an index count below zero reads as zero where it always did and fails the read elsewhere", async () => {
  const turn = await pageAfter(
    "UPDATE long_files SET added = -1 WHERE ordinal = 2 AND path = 'sub.ts'",
  );
  const file = turn().turns[1]?.digest.files.find((entry) => entry.path === "sub.ts");
  expect(file).toMatchObject({ added: 0 });
  const agent = await pageAfter(
    "UPDATE long_agent_files SET added = -1, unknown = 0 WHERE agent_id = 'inline-sub'",
  );
  expect(agent).toThrow();
  // A counter below zero reads as zero, for a turn and for an agent's share.
  const counts = await pageAfter(
    "UPDATE long_counts SET value = -3 WHERE ordinal = 2 AND key = 'commandsRun'; UPDATE long_agent_counts SET value = -3 WHERE agent_id = 'inline-sub' AND key = 'commandsRun'",
  );
  const busy = counts().turns[1];
  expect(busy?.digest.commandsRun).toBe(0);
  expect(busy?.subagents.find((sub) => sub.agentId === "inline-sub")?.digest.commandsRun).toBe(0);
});

test("index values outside the protocol's ranges fail the read instead of reaching it", async () => {
  const huge = "9007199254740993";
  for (const sql of [
    `UPDATE long_files SET added = ${huge} WHERE ordinal = 2`,
    `UPDATE long_agent_files SET removed = ${huge} WHERE agent_id = 'inline-sub'`,
    `UPDATE long_counts SET value = ${huge} WHERE ordinal = 2 AND key = 'commandsRun'`,
    `UPDATE long_counts SET value = 1.5 WHERE ordinal = 2 AND key = 'commandsRun'`,
    `INSERT INTO long_agent_counts SELECT thread_id, ordinal, agent_id, 'inputTokens', -3 FROM long_agent_counts WHERE agent_id = 'inline-sub' LIMIT 1`,
    "UPDATE long_turns SET ordinal = 0 WHERE ordinal = 1",
    "UPDATE long_turns SET started_at = -5 WHERE ordinal = 2",
    "UPDATE long_agents SET started_at = 1.5 WHERE id = 'inline-sub'",
  ])
    expect(await pageAfter(sql), sql).toThrow();
});
