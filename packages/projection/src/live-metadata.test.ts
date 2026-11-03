import { Agent, BackgroundTask, Event, EventPayload, Interaction, Thread } from "@ace/protocol";
import { expect, test } from "vitest";
import { isTestCommand, liveMetadata, updateThread } from "./index.ts";

/*
 * The live hints a thread list entry carries, folded from point changes as the daemon (and the
 * fake daemon) fold them: what background command runs, what the person is asked, how many
 * subagents the root waits on, and whether its step in flight runs tests.
 */

function thread(): Thread {
  return Thread.parse({
    id: "thread-1",
    workspaceId: "ace",
    title: "Relay",
    provider: "claude",
    rootAgentId: "root",
    status: { state: "working", agents: 1 },
    createdAt: 0,
    updatedAt: 0,
  });
}

/** The tasks each test started, as the store keeps them for `background_task.updated`. */
const started = new Map<string, BackgroundTask>();

/** Apply payloads (parsed as the wire parses them) and the live changes they cause. */
function fold(target: Thread, payloads: unknown[], command?: string) {
  for (const [seq, raw] of payloads.entries()) {
    const payload = EventPayload.parse(raw);
    const previous =
      payload.type === "background_task.updated" ? started.get(payload.taskId) : undefined;
    const change = liveMetadata(target, payload, undefined, previous, command);
    if (payload.type === "background_task.started") started.set(payload.task.id, payload.task);
    if (change)
      updateThread(
        target,
        Event.parse({ seq: seq + 1, id: `e${seq}`, threadId: target.id, at: 1, payload: change }),
      );
  }
  return target.live;
}

const task = (id: string, title: string, ambient = false) =>
  BackgroundTask.parse({
    id,
    agentId: "root",
    kind: "shell",
    title,
    status: "running",
    ambient,
    stoppable: true,
    startedAt: 1,
  });

/** A root agent status as the wire carries it (parsed by `fold`). */
const status = (value: Record<string, unknown>) => ({
  type: "agent.status",
  agentId: "root",
  status: value,
});

test("the hints name the background command still running, and forget it once it ends", () => {
  const target = thread();
  expect(
    fold(target, [{ type: "background_task.started", task: task("relay", "bun run dev:relay") }])
      ?.watching,
  ).toEqual([{ id: "relay", title: "bun run dev:relay" }]);
  // A helper that never holds the thread open is not watched.
  expect(
    fold(target, [{ type: "background_task.started", task: task("lsp", "tsserver", true) }])
      ?.watching,
  ).toHaveLength(1);
  expect(
    fold(target, [{ type: "background_task.updated", taskId: "relay", status: "completed" }])
      ?.watching,
  ).toBeUndefined();
});

test("a task standing for a subagent counts as a running subagent, bookkeeping as nothing", () => {
  const target = thread();
  const standIn = BackgroundTask.parse({
    ...task("unbound", "Claude child awaiting task registration"),
    kind: "subagent",
  });
  const bookkeeping = BackgroundTask.parse({
    ...task("overflow", "Claude child transcript recovery exceeded its limit"),
    kind: "other",
    internal: true,
  });
  const live = fold(target, [
    { type: "background_task.started", task: standIn },
    { type: "background_task.started", task: bookkeeping },
  ]);
  expect(live?.runningSubagentCount).toBe(1);
  expect(live?.backgroundTaskCount ?? 0).toBe(0);
  expect(live?.watching).toBeUndefined();
  // Once the provider registers the subagent, its stand-in ends and stops counting.
  expect(
    fold(target, [{ type: "background_task.updated", taskId: "unbound", status: "completed" }])
      ?.runningSubagentCount,
  ).toBe(0);
});

test("the hints say what each open request asks for until it closes", () => {
  const target = thread();
  const asked = Interaction.parse({
    id: "ask",
    threadId: "thread-1",
    agentId: "root",
    blocking: true,
    request: { kind: "question", questions: [{ id: "q", text: "Which cap?", options: [] }] },
    state: "pending",
    createdAt: 1,
  });
  expect(fold(target, [{ type: "interaction.opened", interaction: asked }])?.asking).toEqual([
    { id: "ask", kind: "question" },
  ]);
  expect(
    fold(target, [
      {
        type: "interaction.closed",
        interactionId: "ask",
        state: "resolved",
        closedAt: 2,
      },
    ])?.asking,
  ).toBeUndefined();
});

test("the hints count the subagents the root waits on, and say when its step runs tests", () => {
  const target = thread();
  const waiting = fold(target, [
    status({ state: "blocked", on: "subagents", refs: ["web", "mobile"] }),
  ]);
  expect(waiting?.waitingOn).toBe(2);
  const testing = fold(
    target,
    [status({ state: "working", activity: "tool", itemId: "run" })],
    "bun run test src/replay.test.ts",
  );
  expect(testing).toMatchObject({ step: "tests" });
  expect(testing?.waitingOn).toBeUndefined();
  // Another step: nothing to say beyond working.
  expect(
    fold(target, [status({ state: "working", activity: "tool", itemId: "build" })], "ls")?.step,
  ).toBeUndefined();
  // A subagent's status says nothing about the root.
  expect(
    liveMetadata(
      target,
      EventPayload.parse({
        type: "agent.status",
        agentId: "web",
        status: { state: "blocked", on: "subagents", refs: ["x"] },
      }),
    ),
  ).toBeUndefined();
});

test("test runs are recognised however they are started, and other commands are not", () => {
  for (const command of [
    "bun run test",
    "bun test apps/web",
    "pnpm test -- --run",
    "npx vitest run src",
    "go test ./...",
    "cargo nextest run",
    "python -m pytest -q",
    "./gradlew test",
  ])
    expect([command, isTestCommand(command)]).toEqual([command, true]);
  for (const command of ["bun run build", "test -f package.json", "cat tests/setup.ts", "ls test"])
    expect([command, isTestCommand(command)]).toEqual([command, false]);
});

/** Apply payloads at given times, with the live changes they cause, as the daemon stamps them. */
function timed(target: Thread) {
  let seq = 0;
  return (raw: unknown, time: number, previous?: Agent) => {
    const payload = EventPayload.parse(raw);
    const change = liveMetadata(target, payload, previous, undefined, undefined, time);
    for (const next of change ? [payload, change] : [payload])
      updateThread(
        target,
        Event.parse({ seq: ++seq, id: `e${seq}`, threadId: target.id, at: time, payload: next }),
      );
  };
}

test("a root whose turn ended while its subagents carry on starts its wait then, and drops it once they end", () => {
  const target = thread();
  const at = timed(target);
  at({ type: "thread.updated", status: { state: "working", agents: 1 } }, 1000);
  const child = Agent.parse({
    id: "child",
    threadId: "thread-1",
    parentId: "root",
    origin: "provider_subagent",
    native: { provider: "claude", nativeId: "child" },
    fidelity: "full",
    cwd: "/repo",
    status: { state: "working", activity: "tool" },
    createdAt: 0,
  });
  at({ type: "thread.updated", status: { state: "working", agents: 2 } }, 2000);
  at({ type: "agent.created", agent: child }, 2000);
  expect(target.live?.waitingSince).toBeUndefined();
  // The root's own turn ends: only the subagent still works.
  at({ type: "thread.updated", status: { state: "working", agents: 1 } }, 3000);
  expect(target.live).toMatchObject({ workingSince: 1000, waitingSince: 3000 });
  at({ type: "agent.status", agentId: "child", status: { state: "idle" } }, 4000, child);
  expect(target.live?.waitingSince).toBeUndefined();
  expect(target.live?.workingSince).toBe(4000);
  // The thread finishing clears both.
  at({ type: "thread.updated", status: { state: "done" } }, 5000);
  expect(target.live?.workingSince).toBeUndefined();
  expect(target.live?.waitingSince).toBeUndefined();
});

/** A root run starting, numbered by the daemon into `turn`. */
const runStarted = (id: string, turn: number, trigger: string, time: number) => ({
  type: "run.started",
  run: {
    id,
    threadId: "thread-1",
    agentId: "root",
    trigger,
    turn,
    ordinal: Number(id.replace(/\D/g, "")),
    state: "active",
    startedAt: time,
  },
});
const runEnded = (id: string, time: number) => ({
  type: "run.ended",
  runId: id,
  state: "completed",
  endedAt: time,
});

/** A turn that left a shell running, ended, and paused until that shell finished. */
function pausedAfterFirstTurn() {
  const target = thread();
  target.status = { state: "new" };
  const at = timed(target);
  at(runStarted("run-1", 1, "user", 1000), 1000);
  at({ type: "thread.updated", status: { state: "working", agents: 1 } }, 1000);
  at(runEnded("run-1", 75_000), 75_000);
  at({ type: "thread.updated", status: { state: "waiting", on: "background_task" } }, 75_000);
  at({ type: "thread.updated", status: { state: "done" } }, 100_000);
  expect(target.live?.workingSince).toBeUndefined();
  return { target, at };
}

test.each(["background_completion", "subagent_result"])(
  "a %s run carries the turn on, so Working keeps the turn's start through the pause",
  (trigger) => {
    const { target, at } = pausedAfterFirstTurn();
    // The daemon numbers it into the same turn (ADR 0062).
    at(runStarted("run-2", 1, trigger, 100_000), 100_000);
    at({ type: "thread.updated", status: { state: "working", agents: 1 } }, 100_000);
    expect(target.live?.workingSince).toBe(1000);
  },
);

test("a new turn the person starts times Working from its own start", () => {
  const { target, at } = pausedAfterFirstTurn();
  at(runStarted("run-2", 2, "user", 120_000), 120_000);
  at({ type: "thread.updated", status: { state: "working", agents: 1 } }, 120_000);
  expect(target.live?.workingSince).toBe(120_000);
  // Its status may arrive first: the run's start still restarts the time.
  const early = pausedAfterFirstTurn();
  early.at({ type: "thread.updated", status: { state: "working", agents: 1 } }, 130_000);
  early.at(runStarted("run-2", 2, "user", 130_000), 130_000);
  expect(early.target.live?.workingSince).toBe(130_000);
});
