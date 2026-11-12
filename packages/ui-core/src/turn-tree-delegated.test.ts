import { Agent, Thread, type AgentStatus, type Run } from "@ace/protocol";
import type { ThreadSource } from "@ace/client";
import { expect, test } from "vitest";
import { turnTreeOf } from "./turn-tree.ts";

/*
 * A child ace delegated (`delegate`) has no spawn item in its parent's transcript, and the
 * parent can hand it more work in any later turn. Its work holds the turn waiting on it now,
 * never every turn in the thread.
 */

type Tap = Parameters<ThreadSource["observe"]>[0];

function rootRun(id: string, startedAt: number, endedAt?: number): Run {
  return {
    id: id as Run["id"],
    threadId: "thread-1" as Run["threadId"],
    agentId: "root" as Run["agentId"],
    trigger: "user",
    state: endedAt === undefined ? "active" : "completed",
    startedAt,
    ...(endedAt === undefined ? {} : { endedAt }),
  };
}

function agent(id: string, status: AgentStatus): Agent {
  return Agent.parse({
    id,
    threadId: "thread-1",
    parentId: id === "root" ? null : "root",
    origin: id === "root" ? "root" : "ace",
    native: { provider: "claude" },
    fidelity: id === "root" ? "full" : "summary",
    cwd: "/repo",
    status,
    createdAt: 0,
    ...(id === "root" ? {} : { childThreadId: `thread-${id}` }),
  });
}

/** A store-like reader: entities replaced when they change, taps told which keys changed. */
function thread() {
  const runs = new Map<string, Run>();
  const agents = new Map([["root", agent("root", { state: "idle" })]]);
  const taps = new Set<Tap>();
  let live: string | undefined;
  const reader = {
    order: [] as readonly string[],
    item: () => undefined,
    run: (id: string) => runs.get(id),
    runIds: () => [...runs.keys()],
    agent: (id: string) => agents.get(id),
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
        ...(live ? { live: { rootRunId: live, runningSubagentCount: 0 } } : {}),
      });
    },
    interactionIds: () => [],
    interaction: () => undefined,
    taskIds: () => [],
    task: () => undefined,
    observe: (tap: Tap) => {
      taps.add(tap);
      return () => taps.delete(tap);
    },
  };
  const tell = (...keys: string[]) => {
    for (const tap of taps) tap(new Set(keys));
  };
  return {
    reader,
    turn(id: string, startedAt: number, endedAt?: number) {
      runs.set(id, rootRun(id, startedAt, endedAt));
      live = endedAt === undefined ? id : undefined;
      tell(`run:${id}`, "thread");
    },
    child(id: string, status: AgentStatus) {
      agents.set(id, agent(id, status));
      tell(`agent:${id}`);
    },
  };
}

const working: AgentStatus = { state: "working", activity: "responding" };

// Mutation: leaving an unlinked child's work unattributed, which holds every turn open.
test("a delegated child the parent messages again holds only the newest turn open", () => {
  const world = thread();
  const tree = turnTreeOf(world.reader);
  world.turn("first", 1_000, 2_000);
  world.child("builder", { state: "idle" });
  world.turn("second", 3_000, 4_000);
  expect(tree.settled("first")).toBe(true);
  // A third turn hands the builder more work and waits on it.
  world.turn("third", 5_000);
  world.child("builder", working);
  world.turn("third", 5_000, 6_000);
  expect(tree.settled("first")).toBe(true);
  expect(tree.settled("second")).toBe(true);
  expect(tree.settled("third")).toBe(false);
  world.child("builder", { state: "idle" });
  expect(tree.settled("third")).toBe(true);
});

// Mutation: keeping the child on the turn that was current when it last changed status.
test("a delegated child still working when the person asks again holds the new turn", () => {
  const world = thread();
  const tree = turnTreeOf(world.reader);
  world.turn("first", 1_000, 2_000);
  world.child("builder", working);
  expect(tree.settled("first")).toBe(false);
  world.turn("second", 3_000);
  expect(tree.settled("first")).toBe(true);
  expect(tree.settled("second")).toBe(false);
  world.turn("second", 3_000, 4_000);
  expect(tree.settled("second")).toBe(false);
  world.child("builder", { state: "idle" });
  expect(tree.settled("second")).toBe(true);
});
