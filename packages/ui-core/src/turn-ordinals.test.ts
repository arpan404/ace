import { Agent, Item, Run, Thread } from "@ace/protocol";
import { expect, test } from "vitest";
import { itemTurnOrdinals } from "./turn-ordinals.ts";

const message = (id: string, role: "user" | "assistant", runId?: string): Item =>
  Item.parse({
    id,
    agentId: "root",
    type: "message",
    role,
    parts: [{ type: "text", text: id }],
    synthetic: false,
    raw: [],
    createdAt: 0,
    complete: true,
    ...(runId ? { runId } : {}),
  });
const run = (id: string, agentId: string, ordinal?: number): Run =>
  Run.parse({
    id,
    threadId: "t",
    agentId,
    trigger: "user",
    state: "completed",
    startedAt: 0,
    ...(ordinal ? { ordinal } : {}),
  });

function reader(items: Item[], runs: Run[], agents: Agent[] = []) {
  const byId = new Map<string, Item>(items.map((item) => [item.id, item]));
  const runsById = new Map<string, Run>(runs.map((entry) => [entry.id, entry]));
  const agentsById = new Map<string, Agent>(agents.map((agent) => [agent.id, agent]));
  return {
    order: items.map((item) => item.id),
    item: (id: string) => byId.get(id),
    run: (id: string) => runsById.get(id),
    agent: (id: string) => agentsById.get(id),
    thread: Thread.parse({
      id: "t",
      workspaceId: "w",
      title: "t",
      provider: "claude",
      status: { state: "done" },
      createdAt: 0,
      updatedAt: 0,
      rootAgentId: "root",
    }),
  };
}

test("each item takes its root turn's ordinal, and a person's message the turn answering it", () => {
  const items = [
    message("ask-1", "user"),
    message("answer-1", "assistant", "run-1"),
    message("ask-2", "user"),
    message("answer-2", "assistant", "run-2"),
  ];
  const ordinals = itemTurnOrdinals(
    reader(items, [run("run-1", "root", 1), run("run-2", "root", 2)]),
  );
  expect(ordinals).toEqual([1, 1, 2, 2]);
});

test("a message steered into a running turn belongs to that turn", () => {
  const items = [
    message("ask", "user"),
    message("working", "assistant", "run-7"),
    message("steer", "user"),
    message("more", "assistant", "run-7"),
  ];
  expect(itemTurnOrdinals(reader(items, [run("run-7", "root", 7)]))).toEqual([7, 7, 7, 7]);
});

test("a subagent's items count toward the root turn that spawned it", () => {
  const spawn = Item.parse({
    id: "spawn",
    agentId: "root",
    type: "tool_call",
    runId: "run-3",
    createdAt: 0,
    complete: true,
    call: {
      id: "spawn",
      agentId: "root",
      kind: "agent.spawn",
      title: "Audit",
      status: "succeeded",
      startedAt: 0,
      raw: [],
      detail: { kind: "agent.spawn", description: "Audit" },
    },
  });
  const items = [spawn, message("worker-says", "assistant", "worker-run")];
  const ordinals = itemTurnOrdinals(
    reader(
      items,
      [run("run-3", "root", 3), run("worker-run", "worker")],
      [
        Agent.parse({
          id: "worker",
          threadId: "t",
          parentId: "root",
          origin: "provider_subagent",
          native: { provider: "claude", nativeId: "worker" },
          fidelity: "full",
          cwd: "/repo",
          status: { state: "idle" },
          background: false,
          createdAt: 0,
          spawnedBy: "spawn",
        }),
      ],
    ),
  );
  expect(ordinals).toEqual([3, 3]);
});

const turnRun = (id: string, ordinal: number, turn: number): Run =>
  Run.parse({ ...run(id, "root", ordinal), turn });

test("a run the agent started by itself numbers its items with the ask's turn", () => {
  const items = [
    message("ask", "user"),
    message("answer", "assistant", "run-1"),
    message("after-background-work", "assistant", "run-2"),
    message("next-ask", "user"),
    message("next-answer", "assistant", "run-3"),
  ];
  const runs = [turnRun("run-1", 1, 1), turnRun("run-2", 2, 1), turnRun("run-3", 3, 2)];
  expect(itemTurnOrdinals(reader(items, runs))).toEqual([1, 1, 1, 2, 2]);
});

test("a delegated agent's result stays in the turn before it, even before its run starts", () => {
  const result = Item.parse({
    ...message("result", "user"),
    synthetic: true,
    origin: { kind: "subagent_result" },
  });
  const items = [
    message("ask", "user"),
    message("answer", "assistant", "run-1"),
    result,
    message("next-ask", "user"),
    message("next-answer", "assistant", "run-2"),
  ];
  const runs = [turnRun("run-1", 1, 1), turnRun("run-2", 2, 2)];
  expect(itemTurnOrdinals(reader(items, runs))).toEqual([1, 1, 1, 2, 2]);
});

test("items whose run isn't known, and a message no turn has answered yet, stay unknown", () => {
  const items = [message("old", "assistant", "evicted"), message("just-sent", "user")];
  expect(itemTurnOrdinals(reader(items, []))).toEqual([undefined, undefined]);
});
