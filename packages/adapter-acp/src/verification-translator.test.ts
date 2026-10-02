import { it, expect } from "vitest";
import { harness, required, spawn, end } from "./test-helper.ts";
import { nativeAgentKey } from "./index.ts";
it("reparents a child linked to a former parent's tool without rejecting or moving that tool", () => {
  const h = harness();
  h.ready();
  h.update({
    sessionUpdate: "tool_call",
    toolCallId: "spawn-tool",
    kind: "other",
    rawInput: { _toolName: "task" },
    status: "in_progress",
  });
  spawn(h, "leaf", "root-session", "spawn-tool");
  spawn(h, "branch");
  const original = required(h.tools()[0]);
  h.update({ sessionUpdate: "subagent_update", sessionId: "leaf", state: null }, "branch");
  const leaf = required(h.state.agents[nativeAgentKey("fixture-thread", "leaf")]).agent;
  const branch = required(h.state.agents[nativeAgentKey("fixture-thread", "branch")]).agent;
  expect(leaf.parentId).toBe(branch.id);
  expect(required(h.tools()[0]).agentId).toBe(original.agentId);
  h.update({ sessionUpdate: "tool_call_update", toolCallId: "spawn-tool", status: "completed" });
  expect(required(h.state.agents[nativeAgentKey("fixture-thread", "leaf")]).agent.parentId).toBe(
    branch.id,
  );
});
it("preserves delayed actual native input and name in the completed tool snapshot", () => {
  const h = harness();
  h.ready();
  h.update({
    sessionUpdate: "tool_call",
    toolCallId: "read",
    kind: "read",
    rawInput: {},
    status: "pending",
  });
  h.update({
    sessionUpdate: "tool_call_update",
    toolCallId: "read",
    rawInput: { path: "/actual", futureInput: "essential-custom", _toolName: "readNative" },
  });
  h.update({ sessionUpdate: "tool_call_update", toolCallId: "read", rawInput: { offset: 5 } });
  h.update({ sessionUpdate: "tool_call_update", toolCallId: "read", status: "in_progress" });
  h.update({
    sessionUpdate: "tool_call_update",
    toolCallId: "read",
    status: "completed",
    rawOutput: { content: "contents" },
  });
  const tool = required(h.tools()[0]);
  expect(JSON.stringify(tool.call.raw)).toContain('"futureInput":"essential-custom"');
  expect(JSON.stringify(tool.call.raw)).toContain('"path":"/actual"');
  expect(JSON.stringify(tool.call.raw)).toContain('"offset":5');
  expect(tool.call.raw.some((raw) => raw.name === "readNative")).toBe(true);
  expect(tool.call.raw).toHaveLength(2);
});
it("binds a repaired child to its new parent's tool when that tool arrives late", () => {
  const h = harness();
  h.ready();
  h.update({ sessionUpdate: "tool_call", toolCallId: "old", rawInput: { _toolName: "task" } });
  spawn(h, "leaf", "root-session", "old");
  spawn(h, "branch");
  h.update(
    {
      sessionUpdate: "subagent_update",
      sessionId: "leaf",
      state: null,
      _meta: { cursor: { toolCallId: "new" } },
    },
    "branch",
  );
  h.update({ sessionUpdate: "tool_call_update", toolCallId: "old", status: "completed" });
  h.update(
    { sessionUpdate: "tool_call", toolCallId: "new", rawInput: { _toolName: "task" } },
    "branch",
  );
  const branch = required(h.state.agents[nativeAgentKey("fixture-thread", "branch")]).agent;
  const leaf = required(h.state.agents[nativeAgentKey("fixture-thread", "leaf")]).agent;
  const tool = required(h.tools().find((item) => item.agentId === branch.id));
  expect(leaf.parentId).toBe(branch.id);
  expect(leaf.spawnedBy).toBe(tool.id);
  expect(tool.call.detail).toMatchObject({ kind: "agent.spawn", childAgentId: leaf.id });
});
it("does not settle an old uncertain shell from a reused tool ID in a different native session", () => {
  const h = harness();
  h.ready();
  h.update({ sessionUpdate: "tool_call", toolCallId: "s", kind: "execute", status: "in_progress" });
  end(h, "cancelled");
  h.frame("note", { event: "process-exit", detail: { deliberate: false } });
  h.frame("note", { event: "process-start" });
  h.frame("send", { id: 3, method: "session/new", params: {} });
  h.frame("recv", { id: 3, result: { sessionId: "fresh-root" } });
  h.frame("send", {
    id: 4,
    method: "session/prompt",
    params: { sessionId: "fresh-root", prompt: [] },
  });
  h.update(
    { sessionUpdate: "tool_call", toolCallId: "s", kind: "execute", status: "completed" },
    "fresh-root",
  );
  h.frame("recv", { id: 4, result: { stopReason: "end_turn" } });
  expect(h.tools()).toHaveLength(2);
  expect(Object.values(h.state.tasks).map((task) => task.status)).toEqual(["unknown"]);
  expect(h.state.status).toEqual({ state: "waiting", on: "background_task" });
});
it("keeps original input in every refreshed snapshot while emitting every changed raw frame", () => {
  const h = harness();
  h.ready();
  h.update({
    sessionUpdate: "tool_call",
    toolCallId: "read",
    kind: "read",
    rawInput: { path: "/initial", opaque: "retain-this" },
    status: "in_progress",
  });
  for (let n = 0; n < 25; n++) {
    h.update({ sessionUpdate: "tool_call_update", toolCallId: "read", extension: `change-${n}` });
    const tool = required(h.tools()[0]);
    expect(JSON.stringify(tool.call.raw)).toContain('"path":"/initial"');
    expect(JSON.stringify(tool.call.raw)).toContain('"opaque":"retain-this"');
    expect(JSON.stringify(tool.call.raw)).toContain(`change-${n}`);
    expect(tool.call.raw.length).toBeLessThanOrEqual(2);
  }
});
it("reconciles an uncertain native shell after process restart without creating another tool", () => {
  const h = harness();
  h.ready();
  h.update({
    sessionUpdate: "tool_call",
    toolCallId: "s",
    kind: "execute",
    rawInput: { command: "sleep 60" },
    status: "in_progress",
  });
  const original = required(h.tools()[0]);
  end(h, "cancelled");
  expect(h.state.status).toEqual({ state: "waiting", on: "background_task" });
  h.frame("note", { event: "process-exit", detail: { deliberate: false } });
  h.frame("note", { event: "process-start" });
  h.frame("send", {
    id: 3,
    method: "session/prompt",
    params: { sessionId: "root-session", prompt: [] },
  });
  h.update({
    sessionUpdate: "tool_call_update",
    toolCallId: "s",
    status: "completed",
    rawOutput: { exitCode: 0 },
  });
  h.frame("recv", { id: 3, result: { stopReason: "end_turn" } });
  expect(h.state.status.state).toBe("done");
  expect(h.tools()).toHaveLength(1);
  expect(required(h.tools()[0]).id).toBe(original.id);
  expect(Object.values(h.state.tasks).map((task) => task.status)).toEqual(["completed"]);
});
it("finishes the original background task when its child completes under a repaired parent", () => {
  const h = harness();
  h.ready();
  h.update({
    sessionUpdate: "tool_call",
    toolCallId: "spawn-tool",
    kind: "other",
    rawInput: { _toolName: "task" },
    status: "in_progress",
  });
  spawn(h, "leaf", "root-session", "spawn-tool");
  h.update({
    sessionUpdate: "tool_call_update",
    toolCallId: "spawn-tool",
    status: "completed",
    rawOutput: { isBackground: true },
  });
  spawn(h, "branch");
  h.update({ sessionUpdate: "subagent_update", sessionId: "leaf", state: null }, "branch");
  end(h);
  h.update(
    { sessionUpdate: "subagent_state_update", subagentSessionId: "leaf", state: "completed" },
    "branch",
  );
  h.update({
    sessionUpdate: "subagent_state_update",
    subagentSessionId: "branch",
    state: "completed",
  });
  expect(Object.values(h.state.tasks).map((task) => task.status)).toEqual(["completed"]);
  expect(h.state.status.state).toBe("done");
});
