import { Agent, Interaction, type AgentStatus } from "@ace/protocol";
import { expect, test } from "vitest";
import {
  agentForest,
  forestRequests,
  rowRequest,
  summaryRow,
  type AgentForestNode,
  type ThreadWork,
} from "./index.ts";

const idle: AgentStatus = { state: "idle" };
const working: AgentStatus = { state: "working", activity: "thinking" };
const failed: AgentStatus = {
  state: "failed",
  error: { kind: "provider", message: "stream closed" },
};
const now = 600_000;

const agent = (
  threadId: string,
  id: string,
  status: AgentStatus,
  parentId: string | null = null,
  extra: Record<string, unknown> = {},
) =>
  Agent.parse({
    id,
    parentId,
    threadId,
    origin: parentId ? "ace" : "root",
    native: { provider: "claude", nativeId: `${threadId}-${id}` },
    fidelity: "full",
    cwd: "/project",
    status,
    createdAt: 0,
    ...extra,
  });

const ask = (threadId: string, agentId: string) =>
  Interaction.parse({
    id: `${agentId}-ask`,
    threadId,
    agentId,
    state: "pending",
    blocking: true,
    createdAt: 0,
    request: {
      kind: "approval",
      title: "Run bun install?",
      options: [{ id: "allow", label: "Allow", kind: "allow_once" }],
    },
  });

const work = (agents: Agent[], more: Partial<ThreadWork> = {}): ThreadWork => ({
  agents,
  tasks: [],
  interactions: [],
  ...more,
});

/** The forest's rows by agent id, depth first. */
function rows(works: Map<string, ThreadWork>, viewed = "t1"): Map<string, AgentForestNode> {
  const out = new Map<string, AgentForestNode>();
  const walk = (nodes: readonly AgentForestNode["children"][number][]) => {
    for (const node of nodes) {
      if (node.kind === "agent") out.set(node.agent.id, node);
      walk(node.children);
    }
  };
  walk(agentForest(viewed, works).roots);
  return out;
}

const row = (
  node: AgentForestNode | undefined,
  works: Map<string, ThreadWork>,
  more: { fresh?: boolean; expanded?: boolean } = {},
) => {
  if (!node) throw new Error("no such row");
  return summaryRow({
    node,
    viewed: "t1",
    request: rowRequest(node, forestRequests(works)),
    tool: undefined,
    spawn: undefined,
    fresh: more.fresh ?? true,
    expanded: more.expanded,
    now,
  });
};

test.each([
  {
    case: "a working subagent says what it is doing and counts its time",
    agents: [agent("t1", "root", idle), agent("t1", "kid", working, "root")],
    id: "kid",
    expect: { step: "thinking", tone: undefined, time: "10m", done: false, muted: false },
  },
  {
    case: "a finished one says finished, dimmed, its time unknown without an end",
    agents: [agent("t1", "root", idle), agent("t1", "kid", idle, "root")],
    id: "kid",
    expect: { step: "finished", time: "", done: true, muted: true, still: false },
  },
  {
    case: "a failure says it couldn't finish in red, never the provider's raw words",
    agents: [agent("t1", "root", idle), agent("t1", "kid", failed, "root")],
    id: "kid",
    expect: { step: "couldn't finish", tone: "failed" },
  },
  {
    case: "the main agent waits on the agent under it, and is the tree itself",
    agents: [agent("t1", "root", idle), agent("t1", "kid", working, "root")],
    id: "root",
    expect: { step: "waiting on 1 agent", root: true, done: false },
  },
])("an agent row: $case", ({ agents, id, expect: wanted }) => {
  const works = new Map([["t1", work(agents)]]);
  expect(row(rows(works).get(id), works)).toMatchObject(wanted);
});

test("an agent asking the person says what it asks in the warning colour", () => {
  const works = new Map([
    [
      "t1",
      work([agent("t1", "root", idle), agent("t1", "kid", working, "root")], {
        interactions: [ask("t1", "kid")],
      }),
    ],
  ]);
  expect(row(rows(works).get("kid"), works)).toMatchObject({
    step: "asks: Run bun install?",
    tone: "needs-you",
  });
});

test("a delegate speaks for its thread's main agent, and its request is the delegate's", () => {
  const works = new Map([
    [
      "t1",
      work([
        agent("t1", "root", idle),
        agent("t1", "build", working, "root", { childThreadId: "t2" }),
      ]),
    ],
    ["t2", work([agent("t2", "root", working)], { interactions: [ask("t2", "root")] })],
  ]);
  expect(row(rows(works).get("build"), works)).toMatchObject({
    step: "asks: Run bun install?",
    tone: "needs-you",
    root: false,
  });
});

test("with the connection stale, a live row says what it was last seen doing and its mark holds still", () => {
  const works = new Map([
    ["t1", work([agent("t1", "root", idle), agent("t1", "kid", working, "root")])],
  ]);
  expect(row(rows(works).get("kid"), works, { fresh: false })).toMatchObject({
    step: "last seen thinking",
    still: true,
    done: false,
  });
});

test("a settled-looking row whose thread is still syncing reads syncing, never finished or done", () => {
  const works = new Map([
    [
      "t1",
      work([agent("t1", "root", idle), agent("t1", "kid", idle, "root")], { facts: "syncing" }),
    ],
  ]);
  const said = row(rows(works).get("kid"), works);
  expect(said.step).not.toBe("finished");
  expect(said).toMatchObject({ done: false, muted: true, still: true });
});

test("a folded branch says what it holds; an open one doesn't repeat it", () => {
  const works = new Map([
    [
      "t1",
      work([
        agent("t1", "root", idle),
        agent("t1", "lead", working, "root"),
        agent("t1", "a", working, "lead"),
        agent("t1", "b", idle, "lead"),
      ]),
    ],
  ]);
  const lead = rows(works).get("lead");
  expect(row(lead, works, { expanded: false }).folded).toBe("1 working · 1 done");
  expect(row(lead, works, { expanded: true }).folded).toBe("");
});
