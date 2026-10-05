import { Item, Thread, type TodoEntry } from "@ace/protocol";
import { expect, test } from "vitest";
import {
  latestPlanStep,
  planLabel,
  planProgress,
  planShown,
  planTip,
  type PlanReader,
} from "./plan.ts";

const todo = (content: string, status: TodoEntry["status"]): TodoEntry => ({ content, status });

function todos(id: string, run: string, list: TodoEntry[], agentId = "root"): Item {
  return Item.parse({
    id,
    agentId,
    runId: run,
    createdAt: 1,
    complete: true,
    type: "tool_call",
    call: {
      id,
      agentId,
      kind: "todo",
      title: "Update the plan",
      status: "succeeded",
      detail: { kind: "todo", todos: list },
      startedAt: 1,
      raw: [],
    },
  });
}

function said(id: string, run: string | undefined, role: "user" | "assistant"): Item {
  return Item.parse({
    id,
    agentId: "root",
    ...(run ? { runId: run } : {}),
    createdAt: 1,
    complete: true,
    type: "message",
    role,
    parts: [{ type: "text", text: id }],
  });
}

function reader(items: Item[]): PlanReader {
  const byId = new Map<string, Item>(items.map((item) => [item.id, item]));
  return {
    order: items.map((item) => item.id),
    item: (id) => byId.get(id),
    thread: Thread.parse({
      id: "t",
      workspaceId: "w",
      title: "t",
      provider: "claude",
      rootAgentId: "root",
      status: { state: "working", agents: 1 },
      createdAt: 0,
      updatedAt: 0,
    }),
  };
}

test("the chip follows the latest todo list the main agent wrote in its latest turn", () => {
  const first = todos("plan-1", "run-1", [todo("Read", "in_progress"), todo("Fix", "pending")]);
  const second = todos("plan-2", "run-1", [todo("Read", "completed"), todo("Fix", "pending")]);
  expect(
    latestPlanStep(
      reader([said("ask", undefined, "user"), first, second, said("a", "run-1", "assistant")]),
    ),
  ).toEqual({ itemId: "plan-2", runId: "run-1" });
});

test("a subagent's list never pins", () => {
  const child = todos("child-plan", "run-child", [todo("Grep", "pending")], "child");
  expect(latestPlanStep(reader([said("ask", undefined, "user"), child]))).toBeUndefined();
});

test("a later turn without a list of its own shows no chip", () => {
  const old = todos("plan-1", "run-1", [todo("Read", "pending")]);
  expect(
    latestPlanStep(reader([old, said("next", undefined, "user"), said("a", "run-2", "assistant")])),
  ).toBeUndefined();
});

test("progress counts completed items and reads 'Plan 3/7'", () => {
  const progress = planProgress([
    ...["a", "b", "c"].map((name) => todo(name, "completed")),
    todo("d", "in_progress"),
    ...["e", "f", "g"].map((name) => todo(name, "pending")),
  ]);
  expect(planLabel(progress)).toBe("Plan 3/7");
  expect(progress.settled).toBe(false);
  // The tooltip names what the agent is on now.
  expect(planTip(progress)).toBe("Now: d");
  expect(planTip(planProgress([todo("a", "completed"), todo("b", "pending")]))).toBe("1 of 2 done");
});

test("the chip stays while the turn runs and goes once everything is done and the turn ended", () => {
  const done = planProgress([todo("a", "completed"), todo("b", "cancelled")]);
  expect(done.settled).toBe(true);
  expect(planShown(done, false)).toBe(true);
  expect(planShown(done, true)).toBe(false);
  // A turn that ended with work left keeps its plan in view.
  const left = planProgress([todo("a", "completed"), todo("b", "pending")]);
  expect(planShown(left, true)).toBe(true);
  expect(planShown(planProgress([]), false)).toBe(false);
});
