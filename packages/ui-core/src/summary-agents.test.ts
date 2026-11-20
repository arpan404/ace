import { Agent, BackgroundTask, Interaction, type AgentStatus } from "@ace/protocol";
import { expect, test } from "vitest";
import { agentForest, forestAgentWords, summaryAgents, type ThreadWork } from "./index.ts";

const idle: AgentStatus = { state: "idle" };
const working: AgentStatus = { state: "working", activity: "thinking" };
const askingStatus: AgentStatus = { state: "blocked", on: "human", refs: [] };
const failedStatus: AgentStatus = {
  state: "failed",
  error: { kind: "provider", message: "boom" },
};

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

const question = (threadId: string, agentId: string) =>
  Interaction.parse({
    id: `ask-${agentId}`,
    threadId,
    agentId,
    blocking: true,
    state: "pending",
    createdAt: clock++,
    request: { kind: "question", questions: [{ id: "q", text: "Which branch?", options: [] }] },
  });

const work = (agents: Agent[], extra: Partial<ThreadWork> = {}): ThreadWork => ({
  agents,
  tasks: [],
  interactions: [],
  status: { state: "working", agents: 1 },
  ...extra,
});

const names = (entries: readonly { node: { agent: Agent } }[]) =>
  entries.map((entry) => entry.node.agent.id);

const groups = (works: Map<string, ThreadWork>) => {
  const agents = summaryAgents("t1", agentForest("t1", works), works);
  if (!agents) throw new Error("no agents");
  return {
    asks: names(agents.asks),
    working: names(agents.working),
    failed: names(agents.failed),
    done: names(agents.done),
    total: agents.total,
    finished: agents.finished,
  };
};

test("agents that wait on the person come first, then working, failed and done", () => {
  const works = new Map([
    [
      "t1",
      work(
        [
          agent("t1", "root", working),
          agent("t1", "done1", idle, "root"),
          agent("t1", "broke", failedStatus, "root"),
          agent("t1", "busy", working, "root"),
          agent("t1", "asker", askingStatus, "root"),
          agent("t1", "done2", idle, "root"),
        ],
        { interactions: [] },
      ),
    ],
  ]);
  const shown = groups(works);
  expect(shown).toEqual({
    asks: ["asker"],
    working: ["busy"],
    failed: ["broke"],
    done: ["done1", "done2"],
    total: 5,
    finished: 2,
  });
});

test("the thread's main agent is the page itself, so it is never listed", () => {
  const works = new Map([["t1", work([agent("t1", "root", working)])]]);
  expect(summaryAgents("t1", agentForest("t1", works), works)).toBeUndefined();
});

test("a parent whose subagent still works is working, never done", () => {
  const works = new Map([
    [
      "t1",
      work([
        agent("t1", "root", idle),
        agent("t1", "lead", idle, "root"),
        agent("t1", "helper", working, "lead"),
      ]),
    ],
  ]);
  const shown = groups(works);
  expect(shown.working).toEqual(["lead", "helper"]);
  expect(shown.done).toEqual([]);
});

test("an agent in a delegated thread that asks a question is listed with its request", () => {
  const works = new Map([
    ["t1", work([agent("t1", "root", idle), agent("t1", "delegate", idle, "root", "t2")])],
    [
      "t2",
      work([agent("t2", "root", idle), agent("t2", "deep", askingStatus, "root")], {
        interactions: [question("t2", "deep")],
      }),
    ],
  ]);
  const agents = summaryAgents("t1", agentForest("t1", works), works);
  expect(names(agents?.asks ?? [])).toEqual(["deep"]);
  expect(agents?.asks[0]?.request?.id).toBe("ask-deep");
  // The delegate waits on the asker under it: working, not done.
  expect(names(agents?.working ?? [])).toEqual(["delegate"]);
});

test("a settled agent whose thread is still syncing is never counted done", () => {
  const works = new Map([
    ["t1", work([agent("t1", "root", idle), agent("t1", "delegate", idle, "root", "t2")])],
    ["t2", work([agent("t2", "root", idle)], { facts: "syncing", status: { state: "done" } })],
  ]);
  const shown = groups(works);
  expect(shown.done).toEqual([]);
  expect(shown.working).toEqual(["delegate"]);
});

test("a nested agent is indented under a parent in its own group, and names a parent elsewhere", () => {
  const works = new Map([
    [
      "t1",
      work([
        agent("t1", "root", idle),
        agent("t1", "lead", idle, "root"),
        agent("t1", "a", working, "lead"),
        agent("t1", "b", working, "a"),
        agent("t1", "c", working, "b"),
        agent("t1", "d", working, "c"),
        agent("t1", "reviewer", idle, "root"),
        agent("t1", "r1", idle, "reviewer"),
        agent("t1", "other", idle, "root"),
        agent("t1", "late", failedStatus, "other"),
      ]),
    ],
  ]);
  const agents = summaryAgents("t1", agentForest("t1", works), works);
  const rows = (agents?.working ?? []).map((entry) => [
    entry.node.agent.id,
    entry.indent,
    entry.under?.agent.id ?? null,
  ]);
  // Indentation stops at two levels; past it the row names its parent.
  expect(rows).toEqual([
    ["lead", 0, null],
    ["a", 1, null],
    ["b", 2, null],
    ["c", 2, "b"],
    ["d", 2, "c"],
  ]);
  const failed = (agents?.failed ?? []).map((entry) => [entry.indent, entry.under?.agent.id]);
  expect(failed).toEqual([[0, "other"]]);
  const done = (agents?.done ?? []).map((entry) => [entry.node.agent.id, entry.indent]);
  expect(done).toEqual([
    ["reviewer", 0],
    ["r1", 1],
    ["other", 0],
  ]);
});

test("a row whose thread is still syncing says so, and never reads done", () => {
  const works = new Map([
    ["t1", work([agent("t1", "root", idle), agent("t1", "delegate", idle, "root", "t2")])],
    ["t2", work([agent("t2", "root", idle)], { facts: "syncing", status: { state: "done" } })],
  ]);
  const entry = summaryAgents("t1", agentForest("t1", works), works)?.working[0];
  if (!entry) throw new Error("no row");
  const none = { request: undefined, tool: undefined, spawn: undefined };
  expect(forestAgentWords(true, entry.node, none)).toMatchObject({ step: "syncing", done: false });
});

test("a working subagent says what it does; an asking one what it asks", () => {
  const works = new Map([
    [
      "t1",
      work(
        [
          agent("t1", "root", idle),
          agent(
            "t1",
            "busy",
            { state: "working", activity: "thinking", detail: "Reading the diff" },
            "root",
          ),
          agent("t1", "asker", askingStatus, "root"),
        ],
        { interactions: [question("t1", "asker")] },
      ),
    ],
  ]);
  const agents = summaryAgents("t1", agentForest("t1", works), works);
  const busy = agents?.working[0];
  const asker = agents?.asks[0];
  if (!busy || !asker) throw new Error("missing rows");
  const none = { request: undefined, tool: undefined, spawn: undefined };
  expect(forestAgentWords(true, busy.node, none).step).toBe("Reading the diff");
  expect(forestAgentWords(true, asker.node, { ...none, request: asker.request })).toMatchObject({
    step: "asks: Which branch?",
    tone: "needs-you",
  });
});

test("a remote child that didn't confirm its stop is never listed done, and says why", () => {
  const far = Agent.parse({
    id: "far",
    parentId: "root",
    threadId: "t1",
    childThreadId: "machine-far",
    machine: { machine: "build-box", name: "Build box", contact: "unconfirmed" },
    origin: "ace",
    native: { provider: "codex" },
    fidelity: "summary",
    cwd: "",
    status: idle,
    createdAt: clock++,
  });
  const works = new Map([
    ["t1", work([agent("t1", "root", idle), far], { status: { state: "done" } })],
  ]);
  const agents = summaryAgents("t1", agentForest("t1", works), works);
  expect(names(agents?.done ?? [])).toEqual([]);
  const entry = agents?.working[0];
  if (!entry) throw new Error("no row");
  const none = { request: undefined, tool: undefined, spawn: undefined };
  expect(forestAgentWords(true, entry.node, none)).toMatchObject({
    step: "stopped · didn't confirm",
    done: false,
  });
});

test("a working agent with a request it doesn't wait on stays working", () => {
  // A non-blocking question while the agent keeps working isn't the person's to answer yet.
  const aside = Interaction.parse({
    id: "aside",
    threadId: "t1",
    agentId: "busy",
    blocking: false,
    state: "pending",
    createdAt: clock++,
    request: { kind: "question", questions: [{ id: "q", text: "Which branch?", options: [] }] },
  });
  const works = new Map([
    [
      "t1",
      work([agent("t1", "root", idle), agent("t1", "busy", working, "root")], {
        interactions: [aside],
      }),
    ],
  ]);
  const agents = summaryAgents("t1", agentForest("t1", works), works);
  expect(names(agents?.asks ?? [])).toEqual([]);
  expect(names(agents?.working ?? [])).toEqual(["busy"]);
  expect(agents?.working[0]?.request).toBeUndefined();
});

test("a delegate whose work still runs never says done, even when its own status is idle", () => {
  // The hold its parent keeps for a child on another machine: the work runs, the row is idle.
  const remote = Agent.parse({
    id: "remote",
    parentId: "root",
    threadId: "t1",
    childThreadId: "machine-child",
    machine: { machine: "build-box", name: "Build box" },
    origin: "ace",
    native: { provider: "codex" },
    fidelity: "summary",
    cwd: "",
    status: idle,
    createdAt: clock++,
  });
  const hold = BackgroundTask.parse({
    id: "hold",
    agentId: "root",
    owner: "ace",
    kind: "subagent",
    title: "Remote · Build box",
    status: "running",
    childAgentId: "remote",
    stoppable: true,
    startedAt: 0,
  });
  // And a delegate whose thread is working but couldn't be held (a refused lease).
  const works = new Map<string, ThreadWork>([
    [
      "t1",
      work([agent("t1", "root", idle), remote, agent("t1", "far", idle, "root", "t2")], {
        tasks: [hold],
        status: { state: "done" },
      }),
    ],
    ["t2", { ...work([]), facts: "not_loaded" }],
  ]);
  const agents = summaryAgents("t1", agentForest("t1", works), works);
  const none = { request: undefined, tool: undefined, spawn: undefined };
  const steps = (agents?.working ?? []).map((entry) => [
    entry.node.agent.id,
    forestAgentWords(true, entry.node, none).step,
  ]);
  expect(steps.map(([id]) => id)).toContain("remote");
  for (const [, step] of steps) expect(step).not.toMatch(/^(done|finished)/i);
  expect(Object.fromEntries(steps).remote).toBe("working");
});
