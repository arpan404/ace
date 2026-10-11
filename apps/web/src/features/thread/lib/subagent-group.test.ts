import { ThreadStore, defaultLimits, type ThreadSource } from "@ace/client";
import { createThreadView } from "@ace/projection";
import { Agent, Event, Item, Run, Thread, type AgentStatus } from "@ace/protocol";
import { subagentLabels, subagentStatusLine, subagentTerminal } from "@ace/ui-core";
import { expect, test } from "vitest";
import { agentFactsOf } from "@/lib/agent-facts.ts";
import { readSubagentGroup, subagentEntriesEqual } from "./subagent-group.ts";

const thread = Thread.parse({
  id: "group",
  workspaceId: "repo",
  title: "Review",
  provider: "codex",
  createdAt: 0,
  updatedAt: 0,
  status: { state: "working", agents: 1 },
});
const agent = (id: string, status: AgentStatus, parentId = "root") =>
  Agent.parse({
    id,
    parentId,
    threadId: thread.id,
    spawnedBy: `spawn-${id}`,
    origin: "provider_subagent",
    native: { provider: "codex" },
    fidelity: "full",
    cwd: "/repo",
    name: id,
    status,
    createdAt: 1000,
  });
const spawn = (id: string) =>
  Item.parse({
    id: `spawn-${id}`,
    agentId: "root",
    type: "tool_call",
    createdAt: 1000,
    complete: true,
    call: {
      id: `spawn-${id}`,
      agentId: "root",
      kind: "agent.spawn",
      title: id,
      detail: { kind: "agent.spawn", childAgentId: id },
      status: "succeeded",
      startedAt: 1000,
      raw: [],
    },
  });

function store(agents: Agent[], items: Item[]) {
  const view = createThreadView(thread);
  for (const entry of agents) view.agents[entry.id] = entry;
  for (const item of items) view.items[item.id] = item;
  view.itemOrder = items.map((item) => item.id);
  const reader = new ThreadStore(defaultLimits);
  reader.snapshot(view);
  return reader;
}
const line = (reader: ThreadStore, ids = ["spawn-review"]) =>
  subagentStatusLine(readSubagentGroup(reader, ids).value.map((entry) => entry.state));

test("an idle child cannot finish its group while a grandchild waits for a human", () => {
  const reader = store(
    [
      agent("review", { state: "idle" }),
      agent("nested", { state: "blocked", on: "human", refs: ["approval"] }, "review"),
    ],
    [spawn("review")],
  );
  expect(line(reader)).toBe("1 waiting on you");
  const entry = readSubagentGroup(reader, ["spawn-review"]).value[0];
  expect(entry && subagentLabels[entry.state]).toBe("Waiting on you");
  expect(entry && subagentTerminal(entry.state)).toBe(false);
});

test.each([
  [{ state: "working", activity: "tool" }, "1 working"],
  [{ state: "blocked", on: "background_task", refs: ["shell"] }, "1 waiting"],
  [{ state: "unresponsive", lastSignalAt: 2000 }, "1 not responding"],
  [{ state: "failed", error: { kind: "provider", message: "Review failed" } }, "1 failed"],
  [{ state: "interrupted" }, "1 cancelled"],
  [{ state: "idle" }, "1 done"],
] satisfies [AgentStatus, string][])(
  "a terminal ancestor reports its descendant's %j state",
  (status, expected) => {
    expect(
      line(
        store(
          [agent("review", { state: "idle" }), agent("nested", status, "review")],
          [spawn("review")],
        ),
      ),
    ).toBe(expected);
  },
);

test("a mixed group counts whole child branches and does not count a nested launch twice", () => {
  const reader = store(
    [
      agent("review", { state: "idle" }),
      agent("nested", { state: "working", activity: "thinking" }, "review"),
      agent("finished", { state: "idle" }),
    ],
    [spawn("review"), spawn("nested"), spawn("finished")],
  );
  expect(line(reader, ["spawn-review", "spawn-nested", "spawn-finished"])).toBe(
    "1 working · 1 done",
  );
});

test("a spawn without its child remains unfinished until a late canonical link arrives", () => {
  const item = spawn("review");
  if (item.type !== "tool_call") throw new Error("Missing spawn");
  item.call.detail = { kind: "agent.spawn" };
  const reader = store([], [item]);
  expect(line(reader)).toBe("1 working");
  const linked = store([agent("review", { state: "idle" })], [item]).export().view;
  if (!linked) throw new Error("Missing linked snapshot");
  reader.snapshot({ ...linked, kind: "thread" });
  expect(line(reader)).toBe("1 done");
});

test("a launch awaiting approval says waiting on you even before its child exists", () => {
  const item = spawn("review");
  if (item.type !== "tool_call") throw new Error("Missing spawn");
  item.call.status = "awaiting_approval";
  expect(line(store([], [item]))).toBe("1 waiting on you");
  item.call.status = "cancelled";
  expect(line(store([], [item]))).toBe("1 cancelled");
});

test("a child's latest run end freezes elapsed time after reusable agents finish", () => {
  const reader = store(
    [agent("review", { state: "idle" }), agent("nested", { state: "idle" }, "review")],
    [
      spawn("review"),
      Item.parse({
        id: "answer",
        agentId: "nested",
        runId: "nested-run",
        createdAt: 6000,
        type: "message",
        role: "assistant",
        parts: [{ type: "text", text: "Checked" }],
        complete: true,
      }),
    ],
  );
  const view = reader.export().view;
  if (!view) throw new Error("Missing snapshot");
  view.runs["nested-run"] = Run.parse({
    id: "nested-run",
    threadId: thread.id,
    agentId: "nested",
    trigger: "spawn",
    state: "completed",
    startedAt: 1000,
    endedAt: 7000,
  });
  reader.snapshot({ ...view, kind: "thread" });
  expect(readSubagentGroup(reader, ["spawn-review"]).value[0]?.endedAt).toBe(7000);
});

test("a cancelling launch with an old completion stays live until canonical settlement", () => {
  const launch = Item.parse({
    id: "launch",
    agentId: "root",
    createdAt: 1000,
    type: "delegation.started",
    origin: "ace",
    childThreadId: "child-thread",
    provider: "codex",
    title: "Review",
    role: "review",
    phase: "cancelling",
    status: { state: "done" },
    updatedAt: 6000,
    generation: 0,
    complete: false,
  });
  expect(line(store([], [launch]), ["launch"])).toBe("1 working");
});

test("appending unrelated output does no historical or membership reads for 50 mounted groups", () => {
  const children = Array.from({ length: 50 }, (_, at) => `review-${at}`);
  const reader = store(
    children.map((id) => agent(id, { state: "idle" })),
    children.map(spawn),
  );
  let historicalReads = 0;
  let membershipReads = 0;
  let appended = false;
  const source: ThreadSource = new Proxy(reader, {
    get(target, key) {
      if (key === "item")
        return (id: string) => {
          if (appended && id !== "new-output") historicalReads++;
          return target.item(id);
        };
      if (key === "agentIds")
        return () => {
          if (appended) membershipReads++;
          return target.agentIds();
        };
      const value = Reflect.get(target, key, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  const index = agentFactsOf(source);
  const selections = children.map((id) =>
    index.select(
      (facts) => readSubagentGroup(facts.reader, [`spawn-${id}`], facts),
      subagentEntriesEqual,
    ),
  );
  const stops = selections.map((selection) => selection.subscribe(() => {}));
  const before = selections.map((selection) => selection.getSnapshot());
  try {
    appended = true;
    const seq = (reader.cursor ?? 0) + 1;
    reader.delivery({
      type: "events",
      subscriptionId: "groups",
      afterSeq: seq - 1,
      throughSeq: seq,
      events: [
        Event.parse({
          id: "output-event",
          threadId: thread.id,
          seq,
          at: 2000,
          payload: {
            type: "item.created",
            item: Item.parse({
              id: "new-output",
              agentId: "root",
              createdAt: 2000,
              complete: true,
              type: "message",
              role: "assistant",
              parts: [{ type: "text", text: "Still reviewing" }],
            }),
          },
        }),
      ],
    });
    expect(reader.item("new-output")?.type).toBe("message");
    expect(historicalReads).toBe(0);
    expect(membershipReads).toBe(0);
    for (const [at, selection] of selections.entries())
      expect(selection.getSnapshot()).toBe(before[at]);
  } finally {
    for (const stop of stops) stop();
  }
});
