import {
  Agent,
  BackgroundTask,
  Interaction,
  Item,
  Thread,
  type AgentStatus,
  type Run,
  type ToolCall,
} from "@ace/protocol";
import { expect, test } from "vitest";
import { ledgerOf } from "./thread-ledger.ts";
import {
  activityText,
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
  const reader: ActivityReader = {
    get order() {
      return order;
    },
    item: (id) => byId.get(id),
    run: (id) => runs.get(id),
    agent: (id) => agents.get(id),
    thread: undefined,
    interactionIds: () => [...asked.keys()],
    interaction: (id) => asked.get(id),
    taskIds: () => [...tasks.keys()],
    task: (id) => tasks.get(id),
    queue: undefined,
  };
  return {
    reader,
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
    subagent(id: string, next: AgentStatus) {
      agents.set(id, agent(id, next));
      runs.set(`run-${id}`, run(`run-${id}`, id));
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
  expect(activityText(activity!, 84 * second)).toBe("Working for 1m 14s");
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
  expect(after.watch).toEqual([]);
});

test("while a step waits for approval the line says so, with no timer", () => {
  const { reader } = world(
    { state: "blocked", on: "human", refs: ["ask-install"] },
    [said("ask", "user", 0), shell("install", "bun install", "awaiting_approval", 10 * second)],
    [approval("ask-install", 11 * second)],
  );
  const activity = turnActivity(reader, "root");
  expect(activity).toMatchObject({ label: "Waiting for your approval", tone: "needs-you" });
  expect(activityText(activity!, 400 * second)).toBe("Waiting for your approval");
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
  expect(turnActivity(thread.reader, "root")?.tone).toBe("needs-you");
  thread.ask(approval("ask-install", 10 * second, 370 * second));
  expect(activityText(turnActivity(thread.reader, "root")!, 374 * second)).toBe("Working for 14s");
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
  expect(activityText(turnActivity(thread.reader, "root")!, 90 * second)).toBe(
    "Working for 1m 30s",
  );
  // The person's next message starts a new stretch.
  thread.add(said("again", "user", 100 * second));
  thread.add(shell("next", "ls", "running", 110 * second));
  expect(activityText(turnActivity(thread.reader, "root")!, 120 * second)).toBe("Working for 10s");
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
    label: "Thinking",
    current: undefined,
  });
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

test("a turn that left a command running watches it, by name when it is the only one", () => {
  const thread = world({ state: "blocked", on: "background_task", refs: ["task-dev"] }, [
    shell("dev", "bun run dev:relay", "running", 0),
  ]);
  thread.background("dev");
  const line = turnActivity(thread.reader, "root");
  expect(line).toMatchObject({ label: "Watching", code: "dev", tone: "held" });
  expect(activityText(line!, 10 * second)).toBe("Watching dev");

  thread.background("tunnel");
  thread.status({ state: "blocked", on: "background_task", refs: ["task-dev", "task-tunnel"] });
  expect(turnActivity(thread.reader, "root")).toMatchObject({
    label: "Watching 2 background tasks",
    code: undefined,
  });
});

test("waiting on subagents counts them", () => {
  const thread = world({ state: "blocked", on: "subagents", refs: ["web", "mobile"] }, []);
  expect(turnActivity(thread.reader, "root")?.label).toBe("Waiting on 2 subagents");
  thread.status({ state: "blocked", on: "subagents", refs: ["web"] });
  expect(turnActivity(thread.reader, "root")?.label).toBe("Waiting on 1 subagent");
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
  expect(turnActivity(thread.reader, "root")?.label).toBe("Thinking");
});
