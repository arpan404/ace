import { it, expect } from "vitest";
import { harness, required, spawn, chunk, end } from "./test-helper.ts";
import { nativeAgentKey } from "./keys.ts";

it("keeps a late registered child linked to its actual parent without losing its transcript", () => {
  const h = harness();
  h.ready();
  spawn(h, "parent");
  chunk(h, "early child text", "late");
  h.update(
    {
      sessionUpdate: "tool_call",
      toolCallId: "spawn",
      title: "Task: full description",
      kind: "other",
      rawInput: { _toolName: "task", description: "full description", prompt: "full prompt" },
    },
    "parent",
  );
  spawn(h, "late", "parent");
  const child = required(
    Object.values(h.state.agents).find((a) => a.agent.native.nativeId === "late"),
  ).agent;
  const parent = required(
    Object.values(h.state.agents).find((a) => a.agent.native.nativeId === "parent"),
  ).agent;
  expect(child.parentId).toBe(parent.id);
  expect(child.name).toBe("full description");
  expect(
    Object.values(h.state.items).some(
      (i) =>
        i.agentId === child.id &&
        i.type === "message" &&
        i.parts.some((p) => p.type === "text" && p.text === "early child text"),
    ),
  ).toBe(true);
  end(h);
  expect(h.state.status.state).toBe("working");
});
it("recognizes background spawn completion before child registration and waits for the child", () => {
  const h = harness();
  h.ready();
  h.update({
    sessionUpdate: "tool_call",
    toolCallId: "spawn",
    kind: "other",
    title: "Task: inspect",
    rawInput: { _toolName: "task" },
  });
  h.update({
    sessionUpdate: "tool_call_update",
    toolCallId: "spawn",
    status: "completed",
    rawOutput: { isBackground: true },
  });
  spawn(h);
  chunk(h, "started");
  expect(required(h.state.agents["root"]).agent.status).toMatchObject({
    state: "blocked",
    on: "background_task",
  });
  end(h);
  expect(h.state.status.state).toBe("working");
  h.update({
    sessionUpdate: "subagent_state_update",
    subagentSessionId: "child",
    state: "completed",
  });
  expect(h.state.status.state).toBe("done");
  expect(Object.values(h.state.tasks)[0]?.status).toBe("completed");
});
it("keeps interrupted child work live until the provider confirms cancellation or the grace expires", () => {
  const h = harness();
  h.ready();
  spawn(h);
  chunk(h, "working", "child");
  end(h, "cancelled");
  expect(h.state.status.state).toBe("working");
  h.tick(12005);
  expect(h.state.status.state).toBe("working");
  h.tick(13000);
  expect(h.state.status.state).toBe("done");
  expect(
    required(h.state.agents[nativeAgentKey("fixture-thread", "child")]).agent.status.state,
  ).toBe("interrupted");
});
it("records an interrupted shell as unknown rather than claiming its process stopped", () => {
  const h = harness();
  h.ready();
  h.update({
    sessionUpdate: "tool_call",
    toolCallId: "shell\nopaque",
    kind: "execute",
    rawInput: { command: "sleep 60" },
    status: "in_progress",
  });
  end(h, "cancelled");
  expect(Object.values(h.state.tasks)[0]).toMatchObject({
    kind: "shell",
    status: "unknown",
    stoppable: false,
  });
  expect(required(h.tools()[0]).call.status).toBe("cancelled");
  expect(required(h.state.agents["root"]).agent.status.state).toBe("interrupted");
});
it("reclassifies tool placeholders on refresh while retaining their running status and native inputs", () => {
  const h = harness();
  h.ready();
  h.update({
    sessionUpdate: "tool_call",
    toolCallId: "read",
    title: "Unknown",
    kind: "other",
    status: "in_progress",
  });
  h.update({
    sessionUpdate: "tool_call_update",
    toolCallId: "read",
    title: "Read /a",
    kind: "read",
    rawInput: { path: "/a", future: 1 },
  });
  expect(required(h.tools()[0]).call).toMatchObject({
    kind: "file.read",
    status: "running",
    detail: { path: "/a" },
  });
  expect(required(required(h.tools()[0]).call.raw.at(-1)).data).toMatchObject({
    params: { update: { rawInput: { future: 1 } } },
  });
});
it.each([{ exitCode: 2 }, { error: "oops" }, { permissionDenied: true }])(
  "infers failed tools from completed raw output %j",
  (rawOutput) => {
    const h = harness();
    h.ready();
    h.update({
      sessionUpdate: "tool_call",
      toolCallId: "tool",
      kind: "execute",
      rawInput: { command: "false" },
    });
    h.update({
      sessionUpdate: "tool_call_update",
      toolCallId: "tool",
      status: "completed",
      rawOutput,
    });
    expect(required(h.tools()[0]).call.status).toBe("failed");
  },
);
it("keeps a rejected plan declined when Cursor later reports completion without output", () => {
  const h = harness();
  h.ready();
  h.update({
    sessionUpdate: "tool_call",
    toolCallId: "plan",
    kind: "other",
    rawInput: { _toolName: "createPlan", plan: "Do work" },
  });
  h.frame("recv", {
    id: 0,
    method: "cursor/create_plan",
    params: { toolCallId: "plan", plan: "Do work", name: "Review" },
  });
  expect(h.state.status.state).toBe("needs_you");
  h.frame("send", { id: 0, result: { outcome: { outcome: "rejected", reason: "No" } } });
  expect(required(h.tools()[0]).call.status).toBe("declined");
  h.update({ sessionUpdate: "tool_call_update", toolCallId: "plan", status: "completed" });
  expect(required(h.tools()[0]).call.status).toBe("declined");
});
it("routes asynchronous Cursor questions to the tool owner and preserves dismissed answers", () => {
  const h = harness();
  h.ready();
  spawn(h);
  h.update({ sessionUpdate: "tool_call", toolCallId: "ask", kind: "other" }, "child");
  h.frame("recv", {
    id: 4,
    method: "cursor/ask_question",
    params: {
      toolCallId: "ask",
      questions: [
        { id: "q", prompt: "Choose", options: [{ id: "a", label: "A" }], allowMultiple: true },
      ],
    },
  });
  const interaction = required(Object.values(h.state.interactions)[0]);
  expect(interaction.agentId).toBe(
    required(h.state.agents[nativeAgentKey("fixture-thread", "child")]).agent.id,
  );
  expect(h.state.status.state).toBe("needs_you");
  h.frame("send", { id: 4, result: { outcome: { outcome: "skipped" } } });
  expect(required(Object.values(h.state.interactions)[0]).resolution).toMatchObject({
    kind: "question",
    dismissed: true,
  });
});
it("expires unanswered requests and marks tracked background work unknown when the process dies", () => {
  const h = harness();
  h.ready();
  h.update({
    sessionUpdate: "tool_call",
    toolCallId: "spawn",
    kind: "other",
    rawInput: { _toolName: "task" },
  });
  spawn(h);
  h.update({
    sessionUpdate: "tool_call_update",
    toolCallId: "spawn",
    status: "completed",
    rawOutput: { isBackground: true },
  });
  h.frame("recv", {
    id: 0,
    method: "cursor/ask_question",
    params: { questions: [{ id: "q", prompt: "Choose", options: [] }] },
  });
  h.frame("note", { event: "process-exit", detail: { code: 1 } });
  expect(required(Object.values(h.state.interactions)[0]).state).toBe("expired");
  expect(required(Object.values(h.state.tasks)[0]).status).toBe("unknown");
  expect(h.state.status.state).toBe("failed");
});
it("classifies only final Cursor error segments including split prefixes", () => {
  const h = harness();
  h.ready();
  chunk(h, "\n\nErr");
  chunk(h, "or: Backend failed");
  end(h);
  expect(h.state.status.state).toBe("failed");
  expect(required(h.state.agents["root"]).agent.status).toMatchObject({
    error: { kind: "provider", message: "Backend failed" },
  });
  const normal = harness();
  normal.ready();
  chunk(normal, "Example: \n\nError: is just documentation");
  end(normal);
  expect(normal.state.status.state).toBe("done");
});
it("keeps unknown and malformed frames as raw without rejecting later traffic", () => {
  const h = harness();
  h.ready();
  for (const value of [
    null,
    [],
    "garbage",
    { method: "future/extension", params: { opaque: [1, 2] } },
  ])
    h.frame("recv", value);
  h.update({ sessionUpdate: "future_event", foo: 42 });
  chunk(h, "still here");
  end(h);
  expect(h.state.status.state).toBe("done");
  expect(
    Object.values(h.state.items).some(
      (i) => i.type === "notice" && i.raw.some((r) => objectHas(r.data, "future/extension")),
    ),
  ).toBe(true);
});
function objectHas(data: unknown, method: string) {
  return typeof data === "object" && data !== null && "method" in data && data.method === method;
}
it("does not expire a silent live tool but marks silent model work unresponsive", () => {
  const h = harness();
  h.ready();
  h.update({
    sessionUpdate: "tool_call",
    toolCallId: "shell",
    kind: "execute",
    status: "in_progress",
  });
  h.tick(1000000);
  expect(h.state.status.state).toBe("working");
  const thinking = harness();
  thinking.ready();
  thinking.tick(1000000);
  expect(thinking.state.status.state).toBe("unresponsive");
});
