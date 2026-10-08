import { Item, Thread, type TodoEntry } from "@ace/protocol";
import { expect, test } from "vitest";
import {
  currentStepSince,
  latestPlanSteps,
  planCount,
  planProgress,
  planShown,
  type PlanReader,
} from "./plan.ts";

const todo = (content: string, status: TodoEntry["status"]): TodoEntry => ({ content, status });

function todos(id: string, run: string, list: TodoEntry[], agentId = "root", at = 1): Item {
  return Item.parse({
    id,
    agentId,
    runId: run,
    createdAt: at,
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

test("the tab follows the latest todo list the main agent wrote in its latest turn", () => {
  const first = todos("plan-1", "run-1", [todo("Read", "in_progress"), todo("Fix", "pending")]);
  const second = todos("plan-2", "run-1", [todo("Read", "completed"), todo("Fix", "pending")]);
  expect(
    latestPlanSteps(
      reader([said("ask", undefined, "user"), first, second, said("a", "run-1", "assistant")]),
    ),
  ).toEqual([{ itemId: "plan-2", runId: "run-1", agentId: "root" }]);
});

test("a subagent's list comes after the main agent's, however recent it is", () => {
  const main = todos("plan", "run-1", [todo("Fix", "in_progress")]);
  const child = todos("child-plan", "run-child", [todo("Grep", "pending")], "child");
  expect(
    latestPlanSteps(reader([said("ask", undefined, "user"), main, child])).map(
      (step) => step.agentId,
    ),
  ).toEqual(["root", "child"]);
  // Alone, a subagent's list is still listed: the tab can show it.
  expect(latestPlanSteps(reader([child]))).toEqual([
    { itemId: "child-plan", runId: "run-child", agentId: "child" },
  ]);
});

test("a later turn without a list of its own shows none", () => {
  const old = todos("plan-1", "run-1", [todo("Read", "pending")]);
  expect(
    latestPlanSteps(
      reader([old, said("next", undefined, "user"), said("a", "run-2", "assistant")]),
    ),
  ).toEqual([]);
});

test("progress counts completed items as '3 of 7' and knows the item in progress", () => {
  const progress = planProgress([
    ...["a", "b", "c"].map((name) => todo(name, "completed")),
    todo("d", "in_progress"),
    ...["e", "f", "g"].map((name) => todo(name, "pending")),
  ]);
  expect(planCount(progress)).toBe("3 of 7");
  expect(progress.current?.content).toBe("d");
  expect(progress.settled).toBe(false);
  expect(planProgress([todo("a", "completed"), todo("b", "pending")]).current).toBeUndefined();
});

test("the list stays while the turn runs and goes once everything is done and the turn ended", () => {
  const done = planProgress([todo("a", "completed"), todo("b", "cancelled")]);
  expect(done.settled).toBe(true);
  expect(planShown(done, false)).toBe(true);
  expect(planShown(done, true)).toBe(false);
  // A turn that ended with work left keeps its plan in view.
  const left = planProgress([todo("a", "completed"), todo("b", "pending")]);
  expect(planShown(left, true)).toBe(true);
  expect(planShown(planProgress([]), false)).toBe(false);
});

test("the current item's time counts from the first update that put it in progress", () => {
  const steps = [
    todos("p1", "run-1", [todo("Read", "in_progress"), todo("Fix", "pending")], "root", 100),
    todos("p2", "run-1", [todo("Read", "completed"), todo("Fix", "in_progress")], "root", 200),
    todos("p3", "run-1", [todo("Read", "completed"), todo("Fix", "in_progress")], "root", 300),
  ];
  const view = reader(steps);
  const [latest] = latestPlanSteps(view);
  if (!latest) throw new Error("no plan");
  expect(currentStepSince(view, latest)).toBe(200);
  const finished = reader([
    ...steps,
    todos("p4", "run-1", [todo("Read", "completed"), todo("Fix", "completed")], "root", 400),
  ]);
  const [last] = latestPlanSteps(finished);
  if (!last) throw new Error("no plan");
  expect(currentStepSince(finished, last)).toBeUndefined();
});
