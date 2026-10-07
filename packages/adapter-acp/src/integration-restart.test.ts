import { expect, it } from "vitest";
import { apply } from "@ace/core";
import type { Frame } from "@ace/engine-api";
import { createAcpTranslator } from "./index.ts";
import { chunk, end, harness, spawn } from "./test-helper.ts";

function restored(h: ReturnType<typeof harness>) {
  // Trusted public core state is copied; this does not substitute for the engine's file decoder.
  const state = structuredClone(h.state);
  const translator = createAcpTranslator({
    threadId: state.threadId,
    rootKey: "root",
    identity: { generation: "after-core-restore", cursor: 0 },
  });
  let sequence = 1000;
  let ids = 1000;
  function frame(dir: Frame["dir"], data: unknown) {
    const now = ++sequence;
    const facts = translator.translate(
      { seq: sequence, t: now, dir, channel: dir === "note" ? "recorder" : "stdio", data },
      now,
    );
    return facts.flatMap((fact) =>
      apply(state, fact, { now, ids: { next: () => `restored-${++ids}` } }),
    );
  }
  return { state, frame };
}

it("a restored background tree stays working while its child has an active run", () => {
  const h = harness();
  h.ready();
  h.update({
    sessionUpdate: "tool_call",
    toolCallId: "spawn",
    status: "in_progress",
    rawInput: { _toolName: "task", prompt: "synthetic child" },
  });
  spawn(h);
  chunk(h, "child remains active", "child");
  h.update({
    sessionUpdate: "tool_call_update",
    toolCallId: "spawn",
    status: "completed",
    rawOutput: { isBackground: true },
  });
  end(h);
  expect(h.state.status.state).toBe("working");
  expect(
    Object.values(h.state.agents).find((a) => a.agent.native.nativeId === "root-session")?.agent
      .status,
  ).toMatchObject({ state: "blocked", on: "background_task" });
  expect(Object.values(h.state.tasks)).toContainEqual(
    expect.objectContaining({ kind: "subagent", status: "running" }),
  );
  const r = restored(h);
  r.frame("note", { event: "process-start" });
  expect(r.state.status.state).toBe("working");
  expect(
    Object.values(r.state.agents).find((a) => a.agent.native.nativeId === "child")?.agent.status
      .state,
  ).toBe("working");
});

it("restored shell uncertainty holds waiting after restart and after adapter queue clearing", () => {
  const h = harness();
  h.ready();
  h.update({
    sessionUpdate: "tool_call",
    toolCallId: "shell",
    kind: "execute",
    status: "in_progress",
  });
  end(h, "cancelled");
  h.frame("note", { event: "queue-changed", count: 2 });
  h.frame("note", { event: "process-exit" });
  const r = restored(h);
  r.frame("note", { event: "process-start" });
  r.frame("note", { event: "queue-changed", count: 0 });
  expect(r.state.status).toMatchObject({ state: "waiting", on: "background_task" });
  expect(Object.values(r.state.tasks)).toContainEqual(
    expect.objectContaining({ kind: "shell", status: "unknown" }),
  );
});

it("restored child connection loss stays unresponsive until native child traffic reconnects it", () => {
  const h = harness();
  h.ready();
  spawn(h);
  chunk(h, "child working", "child");
  end(h);
  h.update({
    sessionUpdate: "subagent_state_update",
    subagentSessionId: "child",
    state: "disconnected",
  });
  expect(h.state.status.state).toBe("unresponsive");
  const r = restored(h);
  r.frame("note", { event: "process-start" });
  expect(r.state.status.state).toBe("unresponsive");
  r.frame("recv", {
    method: "session/update",
    params: {
      sessionId: "child",
      update: {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "connection restored" },
      },
    },
  });
  expect(r.state.status.state).toBe("working");
  expect(
    Object.values(r.state.agents).find((a) => a.agent.native.nativeId === "child")?.agent.status
      .state,
  ).toBe("working");
});

it("restored engine input survives provider restart while stale native queue is dropped", () => {
  const h = harness();
  h.ready();
  end(h);
  h.frame("note", { event: "queue-changed", count: 2 });
  apply(
    h.state,
    { type: "queue.changed", count: 3, source: "provider" },
    {
      now: 500,
      ids: { next: () => "queue-metadata" },
    },
  );
  expect(h.state.queueCount).toBe(5);
  const r = restored(h);
  r.frame("note", { event: "process-start" });
  expect(r.state.queueCount).toBe(2);
  expect(r.state.status).toMatchObject({ state: "waiting", on: "queue" });
  r.frame("note", { event: "queue-changed", count: 0 });
  expect(r.state.queueCount).toBe(0);
  expect(r.state.status.state).toBe("done");
});
