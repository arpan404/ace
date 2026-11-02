import {
  Agent,
  Event,
  EventPayload,
  Item,
  Thread,
  ThreadListEntry,
  type AgentStatus,
  type Run,
} from "@ace/protocol";
import { liveMetadata, updateThread } from "@ace/projection";
import { expect, test } from "vitest";
import { threadCard } from "./thread-card.ts";
import { formatElapsed, formatSpan } from "./time.ts";
import { turnActivity, type ActivityReader } from "./turn-activity.ts";

/*
 * The time beside a running thread's status, as the sidebar row and the composer's strip show
 * it. Both read the daemon's stamps, folded here as the daemon folds them, so the two always
 * describe the same span: how long the thread has been in the status shown.
 */

const minute = 60_000;
const start = Date.parse("2026-10-01T14:00:00Z");
const subagents = ["a", "b", "c", "d", "e", "f", "g"];

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
    createdAt: start,
    ...(id === "root" ? {} : { name: id }),
  });
}

/** A thread as the daemon keeps it and as a loaded thread reads it. */
function session() {
  const thread = Thread.parse({
    id: "thread-1",
    workspaceId: "ace",
    title: "Long session",
    provider: "claude",
    rootAgentId: "root",
    status: { state: "done" },
    createdAt: 0,
    updatedAt: 0,
  });
  const agents = new Map<string, Agent>([["root", agent("root", { state: "idle" })]]);
  const run: Run = {
    id: "run-1" as Run["id"],
    threadId: "thread-1" as Run["threadId"],
    agentId: "root" as Run["agentId"],
    trigger: "user",
    state: "active",
    startedAt: start,
  };
  const asked = Item.parse({
    id: "ask",
    agentId: "root",
    runId: "run-1",
    createdAt: start,
    complete: true,
    type: "message",
    role: "user",
    parts: [{ type: "text", text: "Do it all" }],
  });
  let seq = 0;
  /** One event at `at`, and the live hints the daemon folds from it. */
  const emit = (raw: unknown, at: number) => {
    const payload = EventPayload.parse(raw);
    const previous =
      payload.type === "agent.created"
        ? agents.get(payload.agent.id)
        : payload.type === "agent.status"
          ? agents.get(payload.agentId)
          : undefined;
    const change = liveMetadata(thread, payload, previous, undefined, undefined, at);
    for (const next of change ? [payload, change] : [payload])
      updateThread(
        thread,
        Event.parse({ seq: ++seq, id: `e${seq}`, threadId: thread.id, at, payload: next }),
      );
    if (payload.type === "agent.created") agents.set(payload.agent.id, payload.agent);
    if (payload.type === "agent.status" && previous)
      agents.set(payload.agentId, Agent.parse({ ...previous, status: payload.status }));
  };
  /** A fresh reader each time, as after a reconnect: nothing carried over on the client. */
  const reader = (): ActivityReader => ({
    order: ["ask"],
    item: (id) => (id === "ask" ? asked : undefined),
    run: (id) => (id === "run-1" ? run : undefined),
    runIds: () => ["run-1"],
    agent: (id) => agents.get(id),
    agentIds: () => [...agents.keys()],
    thread: Thread.parse(structuredClone(thread)),
    interactionIds: () => [],
    interaction: () => undefined,
    taskIds: () => [],
    task: () => undefined,
    queue: undefined,
  });
  const row = (now: number) =>
    threadCard({
      entry: ThreadListEntry.parse(structuredClone(thread)),
      now,
      baseline: 0,
      settled: false,
      locale: "en-US",
    });
  return { thread, emit, reader, row };
}

/** A root that worked for an hour, then started waiting on seven subagents at `waitAt`. */
function waitingSession(waitAt: number) {
  const s = session();
  s.emit({ type: "thread.updated", status: { state: "working", agents: 1 } }, start);
  s.emit({ type: "run.started", run: { ...s.reader().run("run-1") } }, start);
  s.emit(
    { type: "agent.status", agentId: "root", status: { state: "working", activity: "tool" } },
    start,
  );
  for (const id of subagents)
    s.emit(
      { type: "agent.created", agent: agent(id, { state: "working", activity: "tool" }) },
      waitAt - 1000,
    );
  s.emit(
    { type: "thread.updated", status: { state: "working", agents: 1 + subagents.length } },
    waitAt - 1000,
  );
  s.emit(
    {
      type: "agent.status",
      agentId: "root",
      status: { state: "blocked", on: "subagents", refs: subagents },
    },
    waitAt,
  );
  return s;
}

test("a thread that worked an hour then waits on subagents shows the wait's span on the row and in the composer", () => {
  const waitAt = start + 60 * minute;
  const now = waitAt + 3 * minute;
  const s = waitingSession(waitAt);
  const row = s.row(now);
  const line = turnActivity(s.reader(), "root");
  expect(row.status.compact).toBe("Waiting");
  expect(line).toMatchObject({ label: "Waiting for 7 subagents", waitingOnSubagents: true });
  expect(row.status.since).toBe(waitAt);
  expect(row.pill?.since).toBe(waitAt);
  expect(line?.elapsedFrom).toBe(waitAt);
  // The row says it to the minute and the strip to the second: the same three minutes.
  expect(formatSpan(row.status.since ?? 0, now)).toBe("3m");
  expect(formatElapsed(now - (line?.elapsedFrom ?? 0))).toBe("3m 0s");
});

test("a reconnect or a replayed status leaves the wait's start where it was", () => {
  const waitAt = start + 60 * minute;
  const s = waitingSession(waitAt);
  // The provider re-sends the same status after a reconnect; the daemon folds it again.
  s.emit(
    {
      type: "agent.status",
      agentId: "root",
      status: { state: "blocked", on: "subagents", refs: subagents },
    },
    waitAt + 2 * minute,
  );
  s.emit(
    { type: "thread.updated", status: { state: "working", agents: 1 + subagents.length } },
    waitAt + 2 * minute,
  );
  expect(s.row(waitAt + 3 * minute).status.since).toBe(waitAt);
  expect(turnActivity(s.reader(), "root")?.elapsedFrom).toBe(waitAt);
});

test("the root going back to work times Working from then, on the row and in the composer", () => {
  const waitAt = start + 60 * minute;
  const backAt = waitAt + 5 * minute;
  const s = waitingSession(waitAt);
  for (const id of subagents)
    s.emit({ type: "agent.status", agentId: id, status: { state: "idle" } }, backAt - 1000);
  s.emit(
    { type: "agent.status", agentId: "root", status: { state: "working", activity: "tool" } },
    backAt,
  );
  s.emit({ type: "thread.updated", status: { state: "working", agents: 1 } }, backAt);
  const row = s.row(backAt + minute);
  const line = turnActivity(s.reader(), "root");
  expect(row.status.compact).toBe("Working");
  expect(line?.waitingOnSubagents).toBeUndefined();
  expect(row.status.since).toBe(backAt);
  expect(line?.elapsedFrom).toBe(backAt);
});

test("a run that carries the work on times Working from its own start", () => {
  const s = session();
  s.emit({ type: "thread.updated", status: { state: "working", agents: 1 } }, start);
  s.emit({ type: "run.started", run: { ...s.reader().run("run-1") } }, start);
  s.emit(
    { type: "agent.status", agentId: "root", status: { state: "working", activity: "tool" } },
    start,
  );
  const nextAt = start + 20 * minute;
  s.emit(
    { type: "run.started", run: { ...s.reader().run("run-1"), id: "run-2", startedAt: nextAt } },
    nextAt,
  );
  expect(s.row(nextAt + minute).status.since).toBe(nextAt);
  expect(turnActivity(s.reader(), "root")?.elapsedFrom).toBe(nextAt);
});
