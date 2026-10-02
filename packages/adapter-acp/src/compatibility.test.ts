import { it, expect } from "vitest";
import { harness, required, spawn, chunk, end } from "./test-helper.ts";
import { nativeAgentKey, antigravityQuirks, genericQuirks } from "./index.ts";
it("accepts draft child associations and only ends work for a concrete idle snapshot", () => {
  const h = harness(genericQuirks);
  h.ready();
  h.update({
    sessionUpdate: "subagent_update",
    sessionId: "draft",
    title: "Research",
    state: { state: "running" },
  });
  h.update({ sessionUpdate: "subagent_update", sessionId: "draft", state: null });
  end(h);
  expect(h.state.status.state).toBe("working");
  h.update({
    sessionUpdate: "subagent_update",
    sessionId: "draft",
    state: { state: "idle", stopReason: "end_turn" },
  });
  expect(h.state.status.state).toBe("done");
});
it("models Antigravity subagent calls as placeholder children and ends them with their tool", () => {
  const h = harness(antigravityQuirks);
  h.ready();
  h.update({
    sessionUpdate: "tool_call",
    toolCallId: "spawn",
    title: "start_subagent",
    kind: "other",
    status: "in_progress",
  });
  expect(
    required(Object.values(h.state.agents).find((a) => a.agent.origin === "provider_subagent"))
      .agent.fidelity,
  ).toBe("placeholder");
  h.update({ sessionUpdate: "tool_call_update", toolCallId: "spawn", status: "completed" });
  end(h);
  expect(h.state.status.state).toBe("done");
});
it("turns Antigravity interaction permissions into single choice questions", () => {
  const h = harness(antigravityQuirks);
  h.ready();
  h.frame("recv", {
    id: 0,
    method: "session/request_permission",
    params: {
      sessionId: "root-session",
      toolCall: { toolCallId: "interaction_q", title: "Which?" },
      options: [{ optionId: "a", name: "A", kind: "allow_once" }],
    },
  });
  expect(required(Object.values(h.state.interactions)[0]).request.kind).toBe("question");
  h.frame("send", { id: 0, result: { outcome: { outcome: "selected", optionId: "a" } } });
  expect(required(Object.values(h.state.interactions)[0]).resolution).toMatchObject({
    kind: "question",
    answers: { interaction_q: ["a"] },
  });
});
it.each([
  "Usage Limit Reached\nDaily quota",
  "Agent execution error: bad",
  "connection lost after retry",
])("fails Antigravity text errors: %s", (text) => {
  const h = harness(antigravityQuirks);
  h.ready();
  chunk(h, text);
  end(h);
  expect(h.state.status.state).toBe("failed");
});
it("keeps Antigravity shells live after turn end and closes them from a later update", () => {
  const h = harness(antigravityQuirks);
  h.ready();
  h.update({
    sessionUpdate: "tool_call",
    toolCallId: "shell",
    title: "run_command",
    kind: "execute",
    rawInput: { CommandLine: "sleep 10", Cwd: "/work" },
    status: "in_progress",
  });
  end(h);
  expect(h.state.status.state).toBe("waiting");
  h.update({
    sessionUpdate: "tool_call_update",
    toolCallId: "shell",
    status: "completed",
    rawOutput: { exitCode: 0, combinedOutput: "done" },
  });
  expect(h.state.status.state).toBe("done");
  expect(required(h.tools()[0]).call.detail).toMatchObject({
    command: "sleep 10",
    cwd: "/work",
    output: { tail: "done", bytes: 4, truncated: false },
  });
});
it("exposes the child cancellation grace to the engine deadline scheduler", () => {
  const h = harness();
  h.ready();
  spawn(h);
  chunk(h, "still working", "child");
  h.frame("recv", { id: 2, result: { stopReason: "cancelled" } }, 1000);
  expect(h.deadline()).toBe(13000);
  h.tick(12999);
  expect(
    required(h.state.agents[nativeAgentKey("fixture-thread", "child")]).agent.status.state,
  ).toBe("working");
  h.tick(13000);
  expect(
    required(h.state.agents[nativeAgentKey("fixture-thread", "child")]).agent.status.state,
  ).toBe("interrupted");
  expect(h.state.status.state).toBe("done");
});
it("binds load replay to the existing root before the load response arrives", () => {
  const h = harness();
  h.frame("send", {
    id: 1,
    method: "session/load",
    params: { cwd: "/workspace", sessionId: "existing" },
  });
  h.update(
    { sessionUpdate: "user_message_chunk", content: { type: "text", text: "old input" } },
    "existing",
  );
  h.frame("recv", { id: 1, result: {} });
  expect(Object.values(h.state.agents)).toHaveLength(1);
  expect(h.state.agents["root"]?.agent.native.nativeId).toBe("existing");
});
it("keeps identical tool IDs in different ACP sessions independent", () => {
  const h = harness();
  h.ready();
  spawn(h);
  h.update({
    sessionUpdate: "tool_call",
    toolCallId: "one",
    kind: "read",
    rawInput: { path: "/root" },
    status: "in_progress",
  });
  h.update(
    {
      sessionUpdate: "tool_call",
      toolCallId: "one",
      kind: "read",
      rawInput: { path: "/child" },
      status: "in_progress",
    },
    "child",
  );
  h.update({ sessionUpdate: "tool_call_update", toolCallId: "one", status: "completed" }, "child");
  expect(h.tools().map((tool) => tool.call.status)).toEqual(["running", "succeeded"]);
});
it("preserves opaque child IDs containing lone surrogates without throwing", () => {
  const h = harness();
  h.ready();
  spawn(h, "\ud800");
  chunk(h, "opaque", "\ud800");
  expect(Object.values(h.state.agents)).toHaveLength(2);
  expect(h.state.status.state).toBe("working");
});
it("does not infer completion from an unrecognized prompt response", () => {
  const h = harness();
  h.ready();
  h.frame("recv", { id: 2, result: { futureStop: "paused" } });
  expect(h.state.status.state).toBe("working");
  end(h);
  expect(h.state.status.state).toBe("done");
});
it("keeps a spawned child live even when its foreground tool completes before child traffic", () => {
  const h = harness();
  h.ready();
  h.update({
    sessionUpdate: "tool_call",
    toolCallId: "spawn",
    kind: "other",
    rawInput: { _toolName: "task" },
  });
  spawn(h);
  h.update({ sessionUpdate: "tool_call_update", toolCallId: "spawn", status: "completed" });
  end(h);
  expect(h.state.status.state).toBe("working");
});
it("links a spawn notification that arrives before its spawning tool", () => {
  const h = harness();
  h.ready();
  spawn(h);
  h.update({
    sessionUpdate: "tool_call",
    toolCallId: "spawn",
    kind: "other",
    rawInput: { _toolName: "task" },
  });
  expect(required(h.tools()[0]).call.detail).toMatchObject({
    kind: "agent.spawn",
    childAgentId: required(h.state.agents[nativeAgentKey("fixture-thread", "child")]).agent.id,
  });
});
it("preserves native image and file input as canonical content", () => {
  const h = harness();
  h.ready();
  h.frame("send", {
    id: 3,
    method: "session/prompt",
    params: {
      sessionId: "root-session",
      prompt: [
        { type: "image", data: "AAAA", mimeType: "image/png" },
        { type: "resource_link", uri: "file:///tmp/example.txt" },
      ],
    },
  });
  expect(
    Object.values(h.state.items).some(
      (item) =>
        item.type === "message" &&
        item.parts.some(
          (part) => part.type === "image" && part.url === "data:image/png;base64,AAAA",
        ) &&
        item.parts.some((part) => part.type === "file" && part.path === "/tmp/example.txt"),
    ),
  ).toBe(true);
});
