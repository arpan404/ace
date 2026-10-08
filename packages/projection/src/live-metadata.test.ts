import { BackgroundTask, Event, EventPayload, Interaction, Thread } from "@ace/protocol";
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
