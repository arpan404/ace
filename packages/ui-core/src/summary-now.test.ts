import { Agent, type AgentStatus } from "@ace/protocol";
import { expect, test } from "vitest";
import { agentForest, forestNow, nowLine, type ThreadWork } from "./index.ts";

const idle: AgentStatus = { state: "idle" };
const working: AgentStatus = { state: "working", activity: "tool" };
const done = { state: "done" } as const;

let clock = 0;
const agent = (
  threadId: string,
  id: string,
  status: AgentStatus,
  parentId: string | null = null,
  childThreadId?: string,
) =>
  Agent.parse({
    id,
    parentId,
    threadId,
    childThreadId,
    origin: parentId ? "ace" : "root",
    native: { provider: "claude", nativeId: `${threadId}-${id}` },
    fidelity: "full",
    cwd: "/project",
    status,
    createdAt: clock++,
  });

const work = (agents: Agent[], extra: Partial<ThreadWork> = {}): ThreadWork => ({
  agents,
  tasks: [],
  interactions: [],
  status: done,
  ...extra,
});

/** Now for the viewed thread `t1`, whose own metadata says done. */
const now = (works: Map<string, ThreadWork>) =>
  nowLine({
    status: done,
    ...forestNow(agentForest("t1", works)),
    turn: { startedAt: 0, endedAt: 60_000 },
    prs: [],
    now: 120_000,
  });

test("Now never says done while a delegated grandchild still works", () => {
  const works = new Map([
    ["t1", work([agent("t1", "root", idle), agent("t1", "a", idle, "root", "t2")])],
    ["t2", work([agent("t2", "root", idle), agent("t2", "b", idle, "root", "t3")])],
    ["t3", work([agent("t3", "root", idle), agent("t3", "c", working, "root")])],
  ]);
  const line = now(works);
  expect(line.say).toBe("Working");
  expect(line.sub).toBe("3 agents working");
  works.set("t3", work([agent("t3", "root", idle), agent("t3", "c", idle, "root")]));
  expect(now(works).say).toBe("Done in 1m");
});

test("Now never says done while a delegated thread's facts are unconfirmed", () => {
  const works = new Map([
    ["t1", work([agent("t1", "root", idle), agent("t1", "a", idle, "root", "t2")])],
    ["t2", work([agent("t2", "root", idle), agent("t2", "b", idle, "root")], { facts: "syncing" })],
  ]);
  expect(now(works).say).toBe("Syncing");
  // Still loading (no facts yet) is as unconfirmed as syncing.
  works.delete("t2");
  expect(now(works).say).toBe("Syncing");
  works.set("t2", work([agent("t2", "root", idle), agent("t2", "b", idle, "root")]));
  expect(now(works).say).toBe("Done in 1m");
});

test("a second root agent still working keeps Now from saying done", () => {
  const works = new Map([["t1", work([agent("t1", "root", idle), agent("t1", "side", working)])]]);
  expect(now(works).say).toBe("Working");
});
