import { Agent, type AgentStatus } from "@ace/protocol";
import { expect, test } from "vitest";
import {
  agentForest,
  foldWords,
  forestAsker,
  forestTally,
  type ForestNode,
  type ThreadWork,
} from "./index.ts";

const idle: AgentStatus = { state: "idle" };
const working: AgentStatus = { state: "working", activity: "tool" };

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

const thread = (agents: Agent[], status?: ThreadWork["status"]): ThreadWork => ({
  agents,
  tasks: [],
  interactions: [],
  status,
});

/** The tree as `name(state)[children]` lines, so a test reads like the panel. */
function shape(nodes: readonly ForestNode[], depth = 0): string[] {
  return nodes.flatMap((node) => [
    `${"  ".repeat(depth)}${node.kind === "agent" ? node.agent.id : node.task.id}${node.live ? " live" : ""}`,
    ...shape(node.children, depth + 1),
  ]);
}

test("a delegated thread's own subagents and delegations hang under its delegate, at every depth", () => {
  const works = new Map([
    ["t1", thread([agent("t1", "root", idle), agent("t1", "build", idle, "root", "t2")])],
    [
      "t2",
      thread([
        agent("t2", "root", idle),
        agent("t2", "explore", idle, "root"),
        agent("t2", "review", idle, "root", "t3"),
      ]),
    ],
    ["t3", thread([agent("t3", "root", idle), agent("t3", "check", idle, "root")])],
  ]);
  const forest = agentForest("t1", works);
  expect(shape(forest.roots)).toEqual([
    "root",
    "  build",
    "    explore",
    "    review",
    "      check",
  ]);
  expect(forest.reach).toEqual(["t2", "t3"]);
});

test("every ancestor stays live while a great-grandchild in another thread still works", () => {
  const works = new Map([
    [
      "t1",
      thread([agent("t1", "root", idle), agent("t1", "a", idle, "root", "t2")], { state: "done" }),
    ],
    [
      "t2",
      thread([agent("t2", "root", idle), agent("t2", "b", idle, "root", "t3")], { state: "done" }),
    ],
    [
      "t3",
      thread([agent("t3", "root", idle), agent("t3", "c", working, "root")], {
        state: "working",
        agents: 1,
      }),
    ],
  ]);
  const forest = agentForest("t1", works);
  expect(shape(forest.roots)).toEqual(["root live", "  a live", "    b live", "      c live"]);
  // Once it finishes, the whole branch settles.
  works.set(
    "t3",
    thread([agent("t3", "root", idle), agent("t3", "c", idle, "root")], { state: "done" }),
  );
  expect(shape(agentForest("t1", works).roots)).toEqual(["root", "  a", "    b", "      c"]);
});

test("a finished branch counts what it holds, for its folded line", () => {
  const works = new Map([
    [
      "t1",
      thread([
        agent("t1", "root", idle),
        agent("t1", "a", idle, "root"),
        agent("t1", "a1", idle, "a"),
        agent("t1", "a2", working, "a"),
      ]),
    ],
  ]);
  const [root] = agentForest("t1", works).roots;
  const a = root?.children[0];
  expect(foldWords(forestTally(a?.children ?? []))).toBe("1 working · 1 done");
});

test("threads that delegate back to each other are each shown once and the walk ends", () => {
  const works = new Map([
    ["t1", thread([agent("t1", "root", idle), agent("t1", "to2", idle, "root", "t2")])],
    ["t2", thread([agent("t2", "root", idle), agent("t2", "to1", idle, "root", "t1")])],
  ]);
  const forest = agentForest("t1", works);
  expect(shape(forest.roots)).toEqual(["root", "  to2", "    to1"]);
  expect(forest.reach).toEqual(["t2"]);
});

test("delegation deeper than the bound stops loading but keeps the delegate's row", () => {
  const works = new Map<string, ThreadWork>();
  for (let level = 0; level < 5; level++)
    works.set(
      `t${level}`,
      thread([
        agent(`t${level}`, "root", idle),
        agent(`t${level}`, `d${level}`, idle, "root", `t${level + 1}`),
      ]),
    );
  const forest = agentForest("t0", works, { depth: 2, threads: 16 });
  expect(forest.reach).toEqual(["t1", "t2"]);
  expect(shape(forest.roots)).toEqual(["root", "  d0", "    d1", "      d2"]);
});

test("the person is named by the agent that asks, not the parents waiting on it", () => {
  const works = new Map([
    ["t1", thread([agent("t1", "root", idle), agent("t1", "a", idle, "root", "t2")])],
    [
      "t2",
      thread([
        agent("t2", "root", idle),
        agent("t2", "asker", { state: "blocked", on: "human", refs: [] }, "root"),
      ]),
    ],
  ]);
  const asker = forestAsker(agentForest("t1", works).roots);
  expect(asker?.agent.id).toBe("asker");
  expect(asker?.threadId).toBe("t2");
});
