import { Agent, Interaction, type AgentStatus } from "@ace/protocol";
import { expect, test } from "vitest";
import { agentForest, forestNow, nowLine, summaryAsker, type ThreadWork } from "./index.ts";

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
  expect(line.speak).toBe("working");
  expect(line.sub).toBe("3 agents working");
  works.set("t3", work([agent("t3", "root", idle), agent("t3", "c", idle, "root")]));
  const doneLine = now(works);
  expect(doneLine.say).toBe("Done · 1m");
  expect(doneLine.lead).toBe("Done");
  expect(doneLine.span).toBe("1m");
  expect(doneLine.speak).toBe("done in 1 minute");
});

test("Now never says done while a delegated thread's facts are unconfirmed", () => {
  const works = new Map([
    ["t1", work([agent("t1", "root", idle), agent("t1", "a", idle, "root", "t2")])],
    ["t2", work([agent("t2", "root", idle), agent("t2", "b", idle, "root")], { facts: "syncing" })],
  ]);
  const syncing = now(works);
  expect(syncing.say).toBe("Syncing");
  expect(syncing.speak).toBe("syncing");
  // Still loading (no facts yet) is as unconfirmed as syncing.
  works.delete("t2");
  expect(now(works).say).toBe("Syncing");
  works.set("t2", work([agent("t2", "root", idle), agent("t2", "b", idle, "root")]));
  const doneLine = now(works);
  expect(doneLine.say).toBe("Done · 1m");
  expect(doneLine.speak).toBe("done in 1 minute");
});

test("a second root agent still working keeps Now from saying done", () => {
  const works = new Map([["t1", work([agent("t1", "root", idle), agent("t1", "side", working)])]]);
  expect(now(works).say).toBe("Working");
});

test("Now never says done while a delegated thread couldn't be loaded", () => {
  const works = new Map([
    ["t1", work([agent("t1", "root", idle), agent("t1", "a", idle, "root", "t2")])],
    ["t2", work([], { facts: "not_loaded" })],
  ]);
  expect(now(works).say).toBe("Syncing");
});

test("Now never says done when the viewed thread's own subscription failed, even with done kept", () => {
  const works = new Map([["t1", work([], { facts: "not_loaded" })]]);
  expect(now(works).say).toBe("Syncing");
});

test("a working thread reads its time after a middle dot, with the full phrase for assistive tech", () => {
  const line = nowLine({
    status: { state: "working", agents: 1 },
    tally: { working: 2, done: 0, syncing: 0, commands: 1 },
    live: true,
    confirmed: true,
    turn: { startedAt: 0 },
    prs: [],
    now: 17 * 60_000,
  });
  expect(line.say).toBe("Working · 17m");
  expect(line.lead).toBe("Working");
  expect(line.span).toBe("17m");
  expect(line.speak).toBe("working for 17 minutes");
  expect(line.sub).toBe("2 agents working · 1 command running");
});

const question = (threadId: string, agentId: string, text: string) =>
  Interaction.parse({
    id: `${threadId}-${agentId}-ask`,
    agentId,
    threadId,
    blocking: true,
    state: "pending",
    request: { kind: "question", questions: [{ id: "q", text, options: [] }] },
    createdAt: 0,
  });
const waiting = idle;

test("a delegated thread's main agent asking is named by its delegate, which Open goes to", () => {
  const works = new Map([
    ["t1", work([agent("t1", "root", idle), agent("t1", "a", working, "root", "t2")])],
    [
      "t2",
      work([agent("t2", "root", waiting)], {
        interactions: [question("t2", "root", "Which branch?")],
      }),
    ],
  ]);
  const asker = summaryAsker("t1", agentForest("t1", works), works);
  expect(asker?.root).toBe(false);
  expect(asker?.request?.kind).toBe("question");
  expect(asker?.node.agent.id).toBe("a");
  expect(asker?.open).toEqual({ threadId: "t1", agentId: "a", childThreadId: "t2" });
});

test("the viewed thread's own main agent asking is the main agent, with nothing to open", () => {
  const works = new Map([
    [
      "t1",
      work([agent("t1", "root", waiting)], {
        interactions: [question("t1", "root", "Ship it?")],
      }),
    ],
  ]);
  const asker = summaryAsker("t1", agentForest("t1", works), works);
  expect(asker?.root).toBe(true);
  expect(asker?.open).toBeUndefined();
  expect(
    summaryAsker(
      "t1",
      agentForest("t1", new Map([["t1", work([agent("t1", "root", idle)])]])),
      works,
    ),
  ).toBeUndefined();
});
