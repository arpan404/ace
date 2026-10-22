import { ClientError, ThreadStore, defaultLimits, type ThreadSource } from "@ace/client";
import { createThreadView } from "@ace/projection";
import { Agent, BackgroundTask, Event, Item, Run, Thread, type AgentStatus } from "@ace/protocol";
import { subagentLabels, subagentStatusLine, subagentTerminal } from "@ace/ui-core";
import { expect, test } from "vitest";
import { agentFactsOf } from "@/lib/agent-facts.ts";
import { listedSubagentState, readSubagentGroup, subagentEntriesEqual } from "./subagent-group.ts";

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

function store(agents: Agent[], items: Item[], tasks: BackgroundTask[] = []) {
  const view = createThreadView(thread);
  for (const entry of agents) view.agents[entry.id] = entry;
  for (const item of items) view.items[item.id] = item;
  for (const task of tasks) view.backgroundTasks[task.id] = task;
  view.itemOrder = items.map((item) => item.id);
  const reader = new ThreadStore(defaultLimits);
  reader.snapshot(view);
  return reader;
}
const line = (reader: ThreadStore, ids = ["spawn-review"]) =>
  subagentStatusLine(readSubagentGroup(reader, ids).value.map((entry) => entry.state));

test.each(["running", "unknown", "completed"] as const)(
  "a loaded idle branch includes its descendant's %s background task in settlement",
  (status) => {
    const reader = store(
      [agent("review", { state: "idle" }), agent("nested", { state: "idle" }, "review")],
      [spawn("review")],
      [
        BackgroundTask.parse({
          id: "build",
          agentId: "nested",
          kind: "shell",
          title: "Build",
          status,
          stoppable: true,
          startedAt: 2000,
          ...(status === "completed" ? { endedAt: 7000 } : {}),
        }),
      ],
    );
    const entry = readSubagentGroup(reader, ["spawn-review"]).value[0];
    expect(line(reader)).toBe(status === "completed" ? "1 done" : "1 working");
    expect(entry && subagentLabels[entry.state]).toBe(status === "completed" ? "Done" : "Running");
    expect(entry?.endedAt).toBe(status === "completed" ? 7000 : undefined);
  },
);

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
  expect(entry && subagentLabels[entry.state]).toBe("Needs you");
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
  let taskMembershipReads = 0;
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
      if (key === "taskIds")
        return () => {
          if (appended) taskMembershipReads++;
          return target.taskIds();
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
    expect(taskMembershipReads).toBe(0);
    for (const [at, selection] of selections.entries())
      expect(selection.getSnapshot()).toBe(before[at]);
  } finally {
    for (const stop of stops) stop();
  }
});

const unnamed = (id: string) => {
  const { name: _name, ...rest } = agent(id, { state: "working", activity: "thinking" });
  return Agent.parse({ ...rest, native: { provider: "claude" } });
};
const agentCall = (id: string, detail: Record<string, string>) =>
  Item.parse({
    id: `spawn-${id}`,
    agentId: "root",
    type: "tool_call",
    createdAt: 1000,
    complete: false,
    call: {
      id: `spawn-${id}`,
      agentId: "root",
      kind: "agent.spawn",
      title: "Agent",
      detail: { kind: "agent.spawn", childAgentId: id, ...detail },
      status: "running",
      startedAt: 1000,
      raw: [],
    },
  });

test("a Claude Agent-tool subagent is titled by its description in the subagent group", () => {
  const ids = ["engine", "actions", "client"];
  const descriptions = [
    "Swift engine core + speed",
    "Swift actions + input features",
    "TS client pool, schemas, policy, docs",
  ];
  const reader = store(
    ids.map(unnamed),
    ids.map((id, index) =>
      agentCall(id, {
        description: descriptions[index] ?? "",
        agentType: "general-purpose",
        prompt: "Build it",
      }),
    ),
  );
  const titles = readSubagentGroup(
    reader,
    ids.map((id) => `spawn-${id}`),
  ).value.map((entry) => entry.title);
  expect(titles).toEqual(descriptions);
});

test("a subagent group row falls back to the agent type, then the prompt, never just Subagent", () => {
  const reader = store(
    [unnamed("typed"), unnamed("prompted")],
    [
      agentCall("typed", { agentType: "general-purpose", prompt: "Look around" }),
      agentCall("prompted", { prompt: "Audit the migration shards\nthen report" }),
    ],
  );
  const titles = readSubagentGroup(reader, ["spawn-typed", "spawn-prompted"]).value.map(
    (entry) => entry.title,
  );
  expect(titles).toEqual(["general-purpose", "Audit the migration shards"]);
});

test("a named subagent keeps its own name in the subagent group", () => {
  const reader = store(
    [agent("review", { state: "working", activity: "thinking" })],
    [agentCall("review", { description: "Review the build" })],
  );
  expect(readSubagentGroup(reader, ["spawn-review"]).value.map((entry) => entry.title)).toEqual([
    "review",
  ]);
});

test("the thread list speaks for a delegated child only while the daemon keeps it current", () => {
  const child = Thread.parse({
    ...thread,
    id: "child",
    status: { state: "needs_you", interactions: 1 },
  });
  const fresh = Thread.parse({ ...thread, id: "fresh", status: { state: "new" } });
  const rows = new Map<string, typeof child>([
    [child.id, child],
    [fresh.id, fresh],
  ]);
  const list = (flags: { unconfirmed?: boolean; syncing?: boolean; error?: ClientError }) => ({
    ...flags,
    error: flags.error,
    thread: (id: string) => rows.get(id),
  });
  // A finished child that asks the person again: the list can say so before the parent hears.
  expect(listedSubagentState(list({}), "child")).toBe("human");
  // Old rows say nothing: restored or unfollowed, waiting for a snapshot, or kept after the
  // list's subscription failed.
  expect(listedSubagentState(list({ unconfirmed: true }), "child")).toBeUndefined();
  expect(listedSubagentState(list({ syncing: true }), "child")).toBeUndefined();
  expect(
    listedSubagentState(list({ error: new ClientError("offline", "Lost the list") }), "child"),
  ).toBeUndefined();
  // A child that never started, or one the list doesn't hold, adds nothing either.
  expect(listedSubagentState(list({}), "fresh")).toBeUndefined();
  expect(listedSubagentState(list({}), "elsewhere")).toBeUndefined();
});
