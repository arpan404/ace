import {
  Agent,
  BackgroundTask,
  Interaction,
  Item,
  Thread,
  ThreadRunMetadata,
  type AgentStatus,
  type Run,
  type ToolCall,
} from "@ace/protocol";
import { expect, test, vi } from "vitest";
import type { ThreadSource } from "@ace/client";
import { turnTreeOf } from "./turn-tree.ts";
import { ledgerOf } from "./thread-ledger.ts";
import { listTreeFacts, treeWorking } from "./live-status.ts";
import {
  timedWords,
  readStoppedTurn,
  readTurnActivity,
  turnActivity,
  type ActivityReader,
} from "./turn-activity.ts";

const second = 1000;

function shell(
  id: string,
  command: string,
  status: ToolCall["status"],
  at: number,
  agentId = "root",
): Item {
  return Item.parse({
    id,
    agentId,
    runId: agentId === "root" ? "run-1" : `run-${agentId}`,
    createdAt: at,
    complete: status !== "running",
    type: "tool_call",
    call: {
      id,
      agentId,
      kind: "shell",
      title: `/bin/zsh -lc '${command}'`,
      status,
      detail: { kind: "shell", command },
      startedAt: at,
      raw: [],
    },
  });
}

function said(id: string, role: "user" | "assistant", at: number): Item {
  return Item.parse({
    id,
    agentId: "root",
    runId: "run-1",
    createdAt: at,
    complete: true,
    type: "message",
    role,
    parts: [{ type: "text", text: id }],
  });
}

function approval(id: string, at: number, closedAt?: number, agentId = "root"): Interaction {
  return Interaction.parse({
    id,
    threadId: "thread-1",
    agentId,
    blocking: true,
    request: { kind: "approval", title: "Run bun install?", options: [] },
    state: closedAt === undefined ? "pending" : "resolved",
    createdAt: at,
    ...(closedAt === undefined ? {} : { closedAt }),
  });
}

function question(id: string, at: number): Interaction {
  return Interaction.parse({
    id,
    threadId: "thread-1",
    agentId: "root",
    blocking: false,
    request: { kind: "question", questions: [{ id: "q", text: "Which one?", options: [] }] },
    state: "pending",
    createdAt: at,
  });
}

function agent(id: string, status: AgentStatus): Agent {
  return Agent.parse({
    id,
    threadId: "thread-1",
    parentId: id === "root" ? null : "root",
    origin: id === "root" ? "root" : "provider_subagent",
    native: { provider: "claude", nativeId: id },
    fidelity: "full",
    cwd: "/repo",
    status,
    createdAt: 0,
    ...(id === "root" ? {} : { name: id }),
  });
}

const run = (id: string, agentId: string): Run => ({
  id: id as Run["id"],
  threadId: "thread-1" as Run["threadId"],
  agentId: agentId as Run["agentId"],
  trigger: "user",
  state: "active",
  startedAt: 0,
});

/**
 * A thread as a store keeps it: entities replaced (never mutated) when they change, and the
 * item order replaced when items arrive, so one reader can be read again after each change.
 */
function world(status: AgentStatus, items: Item[], interactions: Interaction[] = []) {
  const runs = new Map([["run-1", run("run-1", "root")]]);
  const agents = new Map([["root", agent("root", status)]]);
  const byId = new Map(items.map((item) => [item.id as string, item]));
  const asked = new Map(interactions.map((interaction) => [interaction.id as string, interaction]));
  const tasks = new Map<string, BackgroundTask>();
  let order: readonly string[] = items.map((item) => item.id);
  let liveRunId: string | undefined;
  const reader: ActivityReader = {
    get order() {
      return order;
    },
    item: (id) => byId.get(id),
    run: (id) => runs.get(id),
    runIds: () => [...runs.keys()],
    agent: (id) => agents.get(id),
    agentIds: () => [...agents.keys()],
    get thread() {
      return Thread.parse({
        id: "thread-1",
        workspaceId: "project",
        title: "Work",
        provider: "claude",
        rootAgentId: "root",
        status: { state: "working", agents: 1 },
        createdAt: 0,
        updatedAt: 0,
        ...(liveRunId
          ? {
              live: {
                rootRunId: liveRunId,
                workingSince: runs.get(liveRunId)?.startedAt,
                runningSubagentCount: 0,
              },
            }
          : {}),
      });
    },
    interactionIds: () => [...asked.keys()],
    interaction: (id) => asked.get(id),
    taskIds: () => [...tasks.keys()],
    task: (id) => tasks.get(id),
    queue: undefined,
  };
  return {
    reader,
    runs,
    tasks,
    liveRun: (id: string) => {
      liveRunId = id;
    },
    add(item: Item) {
      byId.set(item.id, item);
      order = [...order, item.id];
    },
    replace(item: Item) {
      byId.set(item.id, item);
    },
    ask(interaction: Interaction) {
      asked.set(interaction.id, interaction);
    },
    status(next: AgentStatus) {
      agents.set("root", agent("root", next));
    },
    subagent(id: string, next: AgentStatus, spawnedBy?: string) {
      agents.set(id, Agent.parse({ ...agent(id, next), spawnedBy }));
      runs.set(`run-${id}`, {
        ...run(`run-${id}`, id),
        ...(next.state === "idle" || next.state === "failed" || next.state === "interrupted"
          ? { state: "completed" as const, endedAt: 10 }
          : {}),
      });
    },
    background(toolCallId: string) {
      tasks.set(
        `task-${toolCallId}`,
        BackgroundTask.parse({
          id: `task-${toolCallId}`,
          agentId: "root",
          toolCallId,
          kind: "shell",
          title: toolCallId,
          status: "running",
          stoppable: true,
          startedAt: 0,
        }),
      );
    },
  };
}

const working: AgentStatus = { state: "working", activity: "tool" };

test("a working turn times its work and names the step in flight readably", () => {
  const { reader } = world(working, [
    said("ask", "user", 0),
    shell("cat", "cat package.json", "succeeded", 10 * second),
    shell("install", "bun install --frozen-lockfile", "running", 20 * second),
  ]);
  const activity = turnActivity(reader, "root");
  expect(activity?.tone).toBe("working");
  expect(activity?.current).toBe("Running bun install --frozen-lockfile");
  expect(activity).toMatchObject({ label: "Working", elapsedFrom: 0 });
});

test("the step in flight follows the step's own updates, and the line says which to watch", () => {
  const thread = world(working, [
    said("ask", "user", 0),
    shell("run", "bun run build", "running", 0),
  ]);
  const first = readTurnActivity(thread.reader, "root");
  expect(first.activity?.current).toBe("Running bun run build");
  expect(first.watch).toContain("item:run");

  // The provider refines the running command without the root's status changing.
  thread.replace(shell("run", "bun run build apps/web", "running", 0));
  expect(turnActivity(thread.reader, "root")?.current).toBe("Running bun run build apps/web");

  // Once it settles there is no step in flight, and nothing left to watch.
  thread.replace(shell("run", "bun run build apps/web", "succeeded", 0));
  const after = readTurnActivity(thread.reader, "root");
  expect(after.activity?.current).toBeUndefined();
  expect(after.watch).not.toContain("item:run");
});

test("while a step waits for approval the line says so, with no timer", () => {
  const { reader } = world(
    { state: "blocked", on: "human", refs: ["ask-install"] },
    [said("ask", "user", 0), shell("install", "bun install", "awaiting_approval", 10 * second)],
    [approval("ask-install", 11 * second)],
  );
  const activity = turnActivity(reader, "root");
  expect(activity).toMatchObject({ label: "Waiting for your approval", tone: "needs-you" });
  // No timer: the line reads its label alone.
  expect(activity?.elapsedFrom).toBeUndefined();
});

test("a subagent's pending approval reads as waiting on you, though the root works", () => {
  const thread = world(working, [shell("install", "bun install", "running", 0)]);
  thread.subagent("auditor", { state: "blocked", on: "human", refs: ["sub-asks"] });
  thread.add(shell("push", "git push", "awaiting_approval", 4 * second, "auditor"));
  thread.ask(approval("sub-asks", 5 * second, undefined, "auditor"));
  expect(turnActivity(thread.reader, "root")?.label).toBe("Waiting for your approval");
});

test("after the answer the timer resumes from where it stopped, leaving out the wait", () => {
  // Worked 10s, waited 6 minutes on the person, then worked 4s more.
  const thread = world(
    working,
    [said("ask", "user", 0), shell("install", "bun install", "running", 0)],
    [approval("ask-install", 10 * second)],
  );
  // While it waits, the line names the wait and carries no timer.
  expect(turnActivity(thread.reader, "root")).toMatchObject({
    label: "Waiting for your approval",
    tone: "needs-you",
    elapsedFrom: undefined,
  });
  thread.ask(approval("ask-install", 10 * second, 370 * second));
  expect(turnActivity(thread.reader, "root")).toMatchObject({
    label: "Working",
    elapsedFrom: 360 * second,
  });
});

test("overlapping waits on a person count once, and only within the span asked about", () => {
  const { reader } = world(
    working,
    [],
    [
      approval("a", 10 * second, 70 * second),
      approval("b", 40 * second, 100 * second, "auditor"),
      approval("c", 200 * second, 210 * second),
    ],
  );
  const ledger = ledgerOf(reader);
  expect(ledger.waitedWithin(0, 380 * second)).toBe(100 * second);
  expect(ledger.waitedWithin(50 * second, 205 * second)).toBe(55 * second);
  expect(ledger.waitedWithin(120 * second, 150 * second)).toBe(0);
});

test("the timer counts the whole turn's work, across what the agent said between steps", () => {
  const thread = world(working, [said("ask", "user", 0), shell("early", "ls", "succeeded", 0)]);
  expect(turnActivity(thread.reader, "root")?.elapsedFrom).toBe(0);
  // Items arriving one by one keep the turn's one stretch, as one long history read at once would.
  thread.add(said("progress", "assistant", 50 * second));
  thread.add(shell("late", "bun run build", "running", 60 * second));
  expect(turnActivity(thread.reader, "root")).toMatchObject({ label: "Working", elapsedFrom: 0 });
  thread.runs.set("run-1", { ...run("run-1", "root"), state: "completed", endedAt: 90 * second });
  // The person's next message starts a new stretch.
  thread.runs.set("run-2", { ...run("run-2", "root"), startedAt: 100 * second });
  thread.add({ ...said("again", "user", 100 * second), runId: "run-2" as Run["id"] });
  thread.add({ ...shell("next", "ls", "running", 110 * second), runId: "run-2" as Run["id"] });
  expect(turnActivity(thread.reader, "root")).toMatchObject({
    label: "Working",
    elapsedFrom: 100 * second,
  });
});

test("a finished turn has no live line unless a question still waits on the person", () => {
  expect(turnActivity(world({ state: "idle" }, []).reader, "root")).toBeUndefined();
  expect(
    turnActivity(
      world({ state: "failed", error: { kind: "auth", message: "x" } }, []).reader,
      "root",
    ),
  ).toBeUndefined();
  const asked = world({ state: "idle" }, [], [question("which", 5 * second)]);
  expect(turnActivity(asked.reader, "root")).toMatchObject({
    label: "Waiting for your answer",
    tone: "needs-you",
  });
});

test("Stop on its way reads Stopping", () => {
  expect(turnActivity(world(working, []).reader, "root", { stopping: true })?.label).toBe(
    "Stopping…",
  );
});

test("a dev server left running in the background is not the step in flight", () => {
  const thread = world({ state: "working", activity: "thinking" }, [
    said("ask", "user", 0),
    said("note", "assistant", 5),
    shell("dev", "bun run dev", "running", 9),
  ]);
  expect(turnActivity(thread.reader, "root")?.current).toBe("Running bun run dev");
  thread.background("dev");
  expect(turnActivity(thread.reader, "root")).toMatchObject({
    label: "Working",
    current: "dev",
    backgroundCommands: 1,
  });
});

test("a stopped turn whose command still runs never reads Working", () => {
  // The daemon's shape: the stopped run ended interrupted, the root still holds its command.
  const thread = world({ state: "blocked", on: "background_task", refs: ["task-dev"] }, [
    said("ask", "user", 0),
    shell("dev", "bun run dev:relay", "running", 9),
  ]);
  thread.background("dev");
  expect(turnActivity(thread.reader, "root")).toMatchObject({ label: "Running in background" });
  thread.runs.set("run-1", { ...run("run-1", "root"), state: "interrupted", endedAt: 20 });
  expect(turnActivity(thread.reader, "root")).toBeUndefined();
  expect(readStoppedTurn(thread.reader, "root").stopped).toBe(true);
  thread.status({ state: "interrupted" });
  expect(turnActivity(thread.reader, "root")).toBeUndefined();
  // While a subagent is still winding down, the tree still works.
  thread.subagent("web", working);
  expect(turnActivity(thread.reader, "root")).toMatchObject({ label: "Working" });
});

test("a step that runs the tests reads Running tests", () => {
  const thread = world(working, [
    said("ask", "user", 0),
    shell("run", "bun test apps/web", "running", 0),
  ]);
  expect(turnActivity(thread.reader, "root")).toMatchObject({
    label: "Working",
    current: "Running tests…",
  });
});

test("a turn that left a command running reads as running in background, never Working", () => {
  const thread = world({ state: "blocked", on: "background_task", refs: ["task-dev"] }, [
    shell("dev", "bun run dev:relay", "running", 0),
  ]);
  thread.background("dev");
  // No agent is doing a turn: no "Working for" timer, the command named instead.
  expect(turnActivity(thread.reader, "root")).toMatchObject({
    label: "Running in background",
    code: "dev",
    tone: "held",
    elapsedFrom: undefined,
  });

  thread.background("tunnel");
  thread.status({ state: "blocked", on: "background_task", refs: ["task-dev", "task-tunnel"] });
  expect(turnActivity(thread.reader, "root")).toMatchObject({
    label: "Running 2 commands in background",
    tone: "held",
  });
});

test("a rate-limited root whose subagent still works reads Working, as the sidebar does", () => {
  const thread = world({ state: "blocked", on: "rate_limit", refs: [], until: undefined }, []);
  thread.subagent("web", working);
  expect(turnActivity(thread.reader, "root")).toMatchObject({
    label: "Working",
    tone: "working",
    current: "Rate limited",
    subagents: 1,
  });
  expect(
    treeWorking(
      listTreeFacts({
        status: { state: "waiting", on: "rate_limit" },
        live: ThreadRunMetadata.parse({ runningSubagentCount: 1 }),
      }),
    ),
  ).toBe(true);
});

test("a rate-limited root with nothing else running says it is rate limited", () => {
  const thread = world({ state: "blocked", on: "rate_limit", refs: [] }, []);
  expect(turnActivity(thread.reader, "root")).toMatchObject({
    label: "Rate limited",
    tone: "held",
  });
});

test("waiting on subagents counts them", () => {
  const thread = world({ state: "blocked", on: "subagents", refs: ["web", "mobile"] }, []);
  expect(turnActivity(thread.reader, "root")?.subagents).toBe(2);
  thread.status({ state: "blocked", on: "subagents", refs: ["web"] });
  expect(turnActivity(thread.reader, "root")?.subagents).toBe(1);
});

test("saved history has no live activity until a new turn starts", () => {
  const thread = world({ state: "unresponsive", lastSignalAt: 0 }, [
    said("saved reply", "assistant", 0),
  ]);
  const reader = {
    ...thread.reader,
    thread: Thread.parse({
      id: "thread-1",
      workspaceId: "project",
      title: "Saved conversation",
      provider: "claude",
      status: { state: "new" },
      createdAt: 0,
      updatedAt: 0,
      imported: {
        sourceId: "saved",
        instanceId: "account",
        importedAt: 0,
        native: { provider: "claude", nativeId: "native" },
      },
    }),
  };
  expect(turnActivity(reader, "root")).toBeUndefined();
  thread.status({ state: "starting" });
  expect(turnActivity(reader, "root")).toBeUndefined();
  thread.status({ state: "working", activity: "thinking" });
  expect(turnActivity(thread.reader, "root")?.label).toBe("Working");
});

test("continuations keep the entire tree’s server start without resetting its timer, including after replay", () => {
  const thread = world(working, [said("ask", "user", 0), shell("early", "ls", "succeeded", 0)]);
  expect(turnActivity(thread.reader, "root")).toMatchObject({ label: "Working", elapsedFrom: 0 });
  thread.runs.set("run-1", { ...run("run-1", "root"), state: "completed", endedAt: 10_000 });
  thread.runs.set("run-2", {
    ...run("run-2", "root"),
    trigger: "subagent_result",
    startedAt: 40_000,
  });
  thread.liveRun("run-2");
  expect(turnTreeOf(thread.reader).settled("run-1")).toBe(false);
  // The server can start the continuation before its first output arrives.
  expect(turnActivity(thread.reader, "root")).toMatchObject({ label: "Working", elapsedFrom: 0 });
  thread.add({
    ...shell("continue", "bun run build", "running", 40_000),
    runId: "run-2" as Run["id"],
  });
  expect(turnActivity(thread.reader, "root")).toMatchObject({ label: "Working", elapsedFrom: 0 });
  // A new reader replays the same server facts instead of inheriting client-side timer state.
  expect(turnActivity({ ...thread.reader }, "root")).toMatchObject({
    label: "Working",
    elapsedFrom: 0,
  });
  expect(turnTreeOf({ ...thread.reader }).settled("run-1")).toBe(false);
  thread.runs.set("run-2", {
    ...run("run-2", "root"),
    trigger: "subagent_result",
    startedAt: 40_000,
    endedAt: 50_000,
    state: "completed",
  });
  thread.status({ state: "idle" });
  expect(turnTreeOf(thread.reader).settled("run-1")).toBe(true);
  expect(turnTreeOf(thread.reader).endedAt("run-1")).toBe(50_000);
});

test("running-step updates do not revisit retained agents or enumerate historical tasks", () => {
  const thread = world(working, [shell("run", "bun run build", "running", 0)]);
  for (let index = 0; index < 1_000; index++) {
    thread.subagent(`past-${index}`, { state: "idle" });
    thread.background(`past-${index}`);
    const task = thread.tasks.get(`task-past-${index}`);
    if (task) thread.tasks.set(task.id, { ...task, status: "completed", endedAt: 10 });
  }
  let agentReads = 0;
  let taskLists = 0;
  let agentLists = 0;
  const taps = new Set<Parameters<ThreadSource["observe"]>[0]>();
  const reader = {
    ...thread.reader,
    agent: (id: string) => {
      agentReads++;
      return thread.reader.agent(id);
    },
    agentIds: () => {
      agentLists++;
      return thread.reader.agentIds();
    },
    taskIds: () => {
      taskLists++;
      return thread.reader.taskIds();
    },
    observe: (tap: Parameters<ThreadSource["observe"]>[0]) => {
      taps.add(tap);
      return () => taps.delete(tap);
    },
  };
  turnActivity(reader, "root");
  agentReads = taskLists = agentLists = 0;
  thread.replace(shell("run", "bun run build web", "running", 0));
  for (const tap of taps) tap(new Set(["item:run"]));
  expect(turnActivity(reader, "root")?.current).toBe("Running bun run build web");
  expect(agentReads).toBeLessThan(10);
  expect(taskLists).toBe(0);
  expect(agentLists).toBe(0);
  agentReads = 0;
  thread.status({ state: "working", activity: "tool", detail: "Checking the updated build" });
  for (const tap of taps) tap(new Set(["agent:root"]));
  expect(turnActivity(reader, "root")?.tone).toBe("working");
  expect(agentReads).toBeLessThan(10);
  expect(taskLists).toBe(0);
  expect(agentLists).toBe(0);
});

for (const waiting of [false, true]) {
  test(`the first turn owns its silent child's ${waiting ? "approval" : "work"} after a second root run emits output, including snapshot replay`, () => {
    const thread = world(working, [
      said("ask", "user", 0),
      shell("spawn", "start audit", "succeeded", 0),
    ]);
    thread.runs.set("run-1", { ...run("run-1", "root"), state: "completed", endedAt: 10_000 });
    thread.subagent("audit", working, "spawn");
    thread.runs.set("run-2", { ...run("run-2", "root"), startedAt: 40_000 });
    thread.add({ ...said("second", "assistant", 41_000), runId: "run-2" as Run["id"] });
    if (waiting) {
      // A pending request holds the tree even if its owner has already reported idle.
      thread.subagent("audit", { state: "idle" }, "spawn");
      thread.ask(approval("silent-approval", 5_000, undefined, "audit"));
    }
    expect(turnTreeOf(thread.reader).settled("run-1")).toBe(false);
    expect(turnTreeOf({ ...thread.reader }).settled("run-1")).toBe(false);
    thread.subagent("audit", { state: "idle" }, "spawn");
    thread.runs.set("run-audit", {
      ...run("run-audit", "audit"),
      state: "completed",
      endedAt: 50_000,
    });
    if (waiting) thread.ask(approval("silent-approval", 5_000, 45_000, "audit"));
    expect(turnTreeOf(thread.reader).settled("run-1")).toBe(true);
    expect(turnTreeOf(thread.reader).endedAt("run-1")).toBe(50_000);
  });
}

test("an unanchored root request stays with its server turn after a newer run starts and on reload", () => {
  const thread = world(working, [said("ask", "user", 0)], [approval("first-approval", 5_000)]);
  thread.runs.set("run-1", { ...run("run-1", "root"), state: "completed", endedAt: 10_000 });
  thread.runs.set("run-2", { ...run("run-2", "root"), startedAt: 40_000 });
  thread.liveRun("run-2");
  expect(turnTreeOf(thread.reader).settled("run-1")).toBe(false);
  expect(turnTreeOf({ ...thread.reader }).settled("run-1")).toBe(false);
  thread.ask(approval("first-approval", 5_000, 45_000));
  expect(turnTreeOf(thread.reader).settled("run-1")).toBe(true);
});

test("a child's status update visits only current requests even after a thousand retained runs", () => {
  const thread = world(working, [shell("spawn", "start audit", "succeeded", 0)]);
  thread.subagent("audit", working, "spawn");
  for (let index = 0; index < 1000; index++)
    thread.runs.set(`past-${index}`, {
      ...run(`past-${index}`, "audit"),
      state: "completed",
      startedAt: index,
      endedAt: index + 1,
    });
  thread.ask({ ...question("question", 5), agentId: agent("audit", working).id });
  let notify: Parameters<ThreadSource["observe"]>[0] | undefined;
  const reader = {
    ...thread.reader,
    observe: (tap: Parameters<ThreadSource["observe"]>[0]) => {
      notify = tap;
      return () => {};
    },
  };
  const tree = turnTreeOf(reader);
  expect(tree.needsYou).toBe(false);
  let visits = 0;
  const iterate = Set.prototype[Symbol.iterator];
  // Count yielded entries, including skipped dependencies that never cause a reader call.
  const iterations = vi.spyOn(Set.prototype, Symbol.iterator).mockImplementation(function (
    this: Set<unknown>,
  ) {
    const cursor = iterate.call(this);
    const next = cursor.next.bind(cursor);
    cursor.next = (...args) => {
      const result = next(...args);
      if (!result.done) visits++;
      return result;
    };
    return cursor;
  });
  try {
    thread.subagent("audit", { state: "idle" }, "spawn");
    notify?.(new Set(["agent:audit", "run:run-audit"]));
    expect(tree.needsYou).toBe(true);
    expect(tree.settled("run-1")).toBe(false);
    expect(visits).toBeLessThan(80);
  } finally {
    iterations.mockRestore();
  }
});

test("a continuation recovered with only its new output still uses the original server stretch clock", () => {
  const thread = world(working, []);
  thread.runs.set("run-1", { ...run("run-1", "root"), state: "completed", endedAt: 10_000 });
  thread.runs.set("run-2", {
    ...run("run-2", "root"),
    trigger: "background_completion",
    startedAt: 40_000,
  });
  thread.liveRun("run-2");
  thread.add({
    ...shell("new-step", "bun run build", "running", 40_000),
    runId: "run-2" as Run["id"],
  });
  expect(turnActivity(thread.reader, "root")).toMatchObject({ label: "Working", elapsedFrom: 0 });
  expect(turnTreeOf(thread.reader).settled("run-1")).toBe(false);
});

test('a turn\'s time reads after "for", except after a label already in motion', () => {
  expect(timedWords("Working")).toBe("Working for");
  expect(timedWords("Stopping…")).toBe("Stopping…");
});
