import { ThreadStore, defaultLimits } from "@ace/client";
import { createThreadView } from "@ace/projection";
import { Agent, Item, Run, Thread, type AgentStatus } from "@ace/protocol";
import { subagentLabels, subagentStatusLine, subagentTerminal } from "@ace/ui-core";
import { expect, test } from "vitest";
import { readSubagentGroup } from "./subagent-group.ts";

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
