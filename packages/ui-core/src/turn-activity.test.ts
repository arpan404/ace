import {
  Agent,
  BackgroundTask,
  Interaction,
  Item,
  type AgentStatus,
  type Run,
  type ToolCall,
} from "@ace/protocol";
import { expect, test } from "vitest";
import {
  activityText,
  turnActivity,
  workedFor,
  humanWaits,
  type ActivityReader,
} from "./turn-activity.ts";

const second = 1000;

function shell(id: string, command: string, status: ToolCall["status"], at: number): Item {
  return Item.parse({
    id,
    agentId: "root",
    runId: "run-1",
    createdAt: at,
    complete: status !== "running",
    type: "tool_call",
    call: {
      id,
      agentId: "root",
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

function approval(id: string, at: number, closedAt?: number): Interaction {
  return Interaction.parse({
    id,
    threadId: "thread-1",
    agentId: "root",
    blocking: true,
    request: { kind: "approval", title: "Run bun install?", options: [] },
    state: closedAt === undefined ? "pending" : "resolved",
    createdAt: at,
    ...(closedAt === undefined ? {} : { closedAt }),
  });
}

function world(
  status: AgentStatus,
  items: Item[],
  interactions: Interaction[] = [],
  background: string[] = [],
) {
  const tasks = new Map(
    background.map((toolCallId) => [
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
    ]),
  );
  const root = Agent.parse({
    id: "root",
    threadId: "thread-1",
    parentId: null,
    origin: "root",
    native: { provider: "claude", nativeId: "root" },
    fidelity: "full",
    cwd: "/repo",
    status,
    createdAt: 0,
  });
  const run: Run = {
    id: "run-1" as Run["id"],
    threadId: "thread-1" as Run["threadId"],
    agentId: "root" as Run["agentId"],
    trigger: "user",
    state: "active",
    startedAt: 0,
  };
  const byId = new Map(items.map((item) => [item.id as string, item]));
  const asked = new Map(interactions.map((interaction) => [interaction.id as string, interaction]));
  const reader: ActivityReader = {
    order: items.map((item) => item.id),
    item: (id) => byId.get(id),
    run: (id) => (id === "run-1" ? run : undefined),
    agent: (id) => (id === "root" ? root : undefined),
    thread: undefined,
    interactionIds: () => [...asked.keys()],
    interaction: (id) => asked.get(id),
    taskIds: () => [...tasks.keys()],
    task: (id) => tasks.get(id),
    queue: undefined,
  };
  return reader;
}

const working: AgentStatus = { state: "working", activity: "tool" };

test("a working turn times its work and names the step in flight readably", () => {
  const reader = world(working, [
    said("ask", "user", 0),
    shell("cat", "cat package.json", "succeeded", 10 * second),
    shell("install", "bun install --frozen-lockfile", "running", 20 * second),
  ]);
  const activity = turnActivity(reader, "root");
  expect(activity?.tone).toBe("working");
  expect(activity?.current).toBe("Running bun install --frozen-lockfile");
  expect(activityText(activity!, 84 * second)).toBe("Working for 1m 14s");
});

test("while a step waits for approval the line says so, with no timer", () => {
  const reader = world(
    { state: "blocked", on: "human", refs: ["ask-install"] },
    [said("ask", "user", 0), shell("install", "bun install", "awaiting_approval", 10 * second)],
    [approval("ask-install", 11 * second)],
  );
  const activity = turnActivity(reader, "root");
  expect(activity).toMatchObject({ label: "Waiting for your approval", tone: "needs-you" });
  expect(activityText(activity!, 400 * second)).toBe("Waiting for your approval");
});

test("a subagent's pending approval also reads as waiting on you, though the root works", () => {
  const reader = world(
    working,
    [shell("install", "bun install", "running", 0)],
    [approval("sub-asks", 5 * second)],
  );
  expect(turnActivity(reader, "root")?.label).toBe("Waiting for your approval");
});

test("after the answer the timer resumes from where it stopped, leaving out the wait", () => {
  // Worked 10s, waited 6 minutes on the person, then worked 4s more.
  const reader = world(
    working,
    [said("ask", "user", 0), shell("install", "bun install", "running", 0)],
    [approval("ask-install", 10 * second, 370 * second)],
  );
  const activity = turnActivity(reader, "root");
  expect(activityText(activity!, 374 * second)).toBe("Working for 14s");
});

test("a finished stretch's worked time leaves out the time spent waiting on a person", () => {
  const reader = world(working, [], [approval("ask-install", 10 * second, 370 * second)]);
  expect(workedFor(humanWaits(reader), 0, 380 * second)).toBe(20 * second);
});

test("the timer starts at the work after the agent last spoke", () => {
  const reader = world(working, [
    said("ask", "user", 0),
    shell("early", "ls", "succeeded", 0),
    said("progress", "assistant", 50 * second),
    shell("late", "bun run test", "running", 60 * second),
  ]);
  expect(activityText(turnActivity(reader, "root")!, 90 * second)).toBe("Working for 30s");
});

test("a finished turn has no live line unless a question still waits on the person", () => {
  expect(turnActivity(world({ state: "idle" }, []), "root")).toBeUndefined();
  expect(
    turnActivity(world({ state: "failed", error: { kind: "auth", message: "x" } }, []), "root"),
  ).toBeUndefined();
});

test("Stop on its way reads Stopping", () => {
  expect(turnActivity(world(working, []), "root", { stopping: true })?.label).toBe("Stopping…");
});

test("a dev server left running in the background is not the step in flight", () => {
  const reader = world(
    { state: "working", activity: "thinking" },
    [
      said("ask", "user", 0),
      said("note", "assistant", 5),
      shell("dev", "bun run dev", "running", 9),
    ],
    [],
    ["dev"],
  );
  expect(turnActivity(reader, "root")).toMatchObject({ label: "Thinking", current: undefined });
});
