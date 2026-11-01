import { Agent, type AgentStatus } from "@ace/protocol";
import { expect, test } from "vitest";
import {
  agentForest,
  foldFinished,
  foldWords,
  forestLayers,
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

/** A thread whose main agent has `width` subagents, every other one working, each delegating. */
function wide(width: number, threads: number): Map<string, ThreadWork> {
  const works = new Map<string, ThreadWork>();
  const per = Math.ceil(width / threads);
  for (let t = 0; t < threads; t++) {
    const id = `w${t}`;
    const agents = [agent(id, "root", idle)];
    for (let index = 0; index < per; index++) {
      const delegate = index === 0 && t + 1 < threads ? `w${t + 1}` : undefined;
      agents.push(agent(id, `a${index}`, index % 2 ? working : idle, "root", delegate));
    }
    works.set(id, thread(agents));
  }
  return works;
}

const median = (runs: number[]) => runs.toSorted((left, right) => left - right)[runs.length >> 1] ?? 0;

/** The median time of joining `works`, after a warm-up. */
function joinTime(works: Map<string, ThreadWork>): number {
  agentForest("w0", works);
  const runs: number[] = [];
  for (let run = 0; run < 7; run++) {
    const start = performance.now();
    agentForest("w0", works);
    runs.push(performance.now() - start);
  }
  return median(runs);
}

test("a wide tree of 2,000 agents joins in time proportional to its size", () => {
  const small = joinTime(wide(500, 4));
  const large = joinTime(wide(4000, 16));
  // Eight times the agents: linear work costs about 8x, the old quadratic join about 64x.
  expect(large / Math.max(small, 0.05)).toBeLessThan(24);
  const [root] = agentForest("w0", wide(2000, 1)).roots;
  expect(root?.tally).toEqual({ working: 1000, done: 1000, commands: 0 });
});

test("joins that share kept layers still see the new facts of the one thread that changed", () => {
  const works = wide(400, 4);
  const layers = forestLayers();
  const first = agentForest("w0", works, undefined, layers);
  // w3 finishes all its work; the other threads' facts objects stay the same.
  const settled = works.get("w3");
  works.set("w3", thread((settled?.agents ?? []).map((one) => ({ ...one, status: idle }))));
  const second = agentForest("w0", works, undefined, layers);
  const tally = (forest: typeof first) => forestTally(forest.roots);
  // Its 50 working agents settle, and so does the delegate in w2 that waited on them.
  expect(tally(first).working - tally(second).working).toBe(51);
});

test("working and waiting children come before finished ones", () => {
  const works = new Map([
    [
      "t1",
      thread([
        agent("t1", "root", idle),
        agent("t1", "early", idle, "root"),
        agent("t1", "asks", { state: "blocked", on: "human", refs: [] }, "root"),
        agent("t1", "late", working, "root"),
      ]),
    ],
  ]);
  expect(shape(agentForest("t1", works).roots)).toEqual([
    "root live",
    "  asks live",
    "  late live",
    "  early",
  ]);
});

test("nineteen finished siblings fold into one row below the live ones", () => {
  const agents = [agent("t1", "root", idle)];
  for (let index = 0; index < 28; index++)
    agents.push(agent("t1", `s${index}`, index < 9 ? working : idle, "root"));
  const [root] = agentForest("t1", new Map([["t1", thread(agents)]])).roots;
  const rows = foldFinished(root?.key ?? "", root?.children ?? []);
  expect(rows.map((row) => (row.kind === "node" ? "row" : `${row.nodes.length} done`))).toEqual([
    ...Array.from({ length: 9 }, () => "row"),
    "19 done",
  ]);
});

test("a delegated thread still syncing marks its branch unconfirmed and the forest unsettled", () => {
  const works = new Map<string, ThreadWork>([
    ["t1", thread([agent("t1", "root", idle), agent("t1", "a", idle, "root", "t2")])],
    [
      "t2",
      {
        ...thread([agent("t2", "root", idle), agent("t2", "b", idle, "root")]),
        facts: "syncing",
      },
    ],
  ]);
  const forest = agentForest("t1", works);
  const a = forest.roots[0]?.children[0];
  expect(a?.kind === "agent" && a.stale).toBe(true);
  expect(forest.confirmed).toBe(false);
  // Its finished-looking rows never fold into "done" while unconfirmed.
  expect(foldFinished(a?.key ?? "", a?.children ?? [], 1)[0]?.kind).toBe("node");
  works.set("t2", thread([agent("t2", "root", idle), agent("t2", "b", idle, "root")]));
  expect(agentForest("t1", works).confirmed).toBe(true);
});

test("a delegate whose thread had no room stands alone, marked not loaded", () => {
  const works = new Map<string, ThreadWork>([
    ["t1", thread([agent("t1", "root", idle), agent("t1", "a", working, "root", "t2")])],
    ["t2", { agents: [], tasks: [], interactions: [], facts: "not_loaded" }],
  ]);
  const a = agentForest("t1", works).roots[0]?.children[0];
  expect(a?.kind === "agent" && a.notLoaded).toBe(true);
  expect(a?.live).toBe(true);
  expect(a?.children).toEqual([]);
});
