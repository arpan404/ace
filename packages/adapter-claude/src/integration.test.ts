import { apply } from "@ace/core";
import { expect, test } from "vitest";
import { harness } from "./translator.test-helper.ts";

test("an active background child keeps its finished root's thread working", () => {
  const h = harness();
  h.init();
  h.tool("launch", "Agent");
  h.system("background_tasks_changed", {
    tasks: [{ task_id: "C", tool_use_id: "launch", task_type: "local_agent" }],
  });
  h.result();
  expect(h.state.agents["root"]?.agent.status).toMatchObject({
    state: "blocked",
    on: "background_task",
  });
  expect(
    Object.values(h.state.agents).find((record) => record.agent.native.nativeId === "C")?.agent,
  ).toMatchObject({ background: true, status: { state: "working" } });
  expect(h.state.status.state).toBe("working");
  h.system("task_updated", { task_id: "C", patch: { status: "completed" } });
  h.tick(10_000);
  expect(h.state.status.state).toBe("done");
});

test("Claude restart discards the native queue while retaining engine-held inputs", () => {
  const h = harness();
  h.init();
  let id = 0;
  h.events.push(
    ...apply(
      h.state,
      { type: "queue.changed", count: 2, source: "engine" },
      { now: 1, ids: { next: (kind) => `engine:${kind}:${++id}` } },
    ),
  );
  h.result({ queued_turn_count: 3 });
  expect(h.state.queueCount).toBe(5);
  h.send({ type: "process.exited", deliberate: true }, "lifecycle", "note");
  h.send({ type: "process.started", session_id: "s", process_id: "reopened" }, "lifecycle", "note");
  expect(h.state.queueCount).toBe(2);
  expect(h.state.status).toMatchObject({ state: "waiting", on: "queue" });
  h.init();
  h.result({ queued_turn_count: 0 });
  expect(h.state.queueCount).toBe(2);
  expect(h.state.status).toMatchObject({ state: "waiting", on: "queue" });
});
